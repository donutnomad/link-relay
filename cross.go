package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	ListenAddr = ":18999"
	OAuthTTL   = 3 * time.Minute
	MailTTL    = 5 * time.Minute
)

var (
	apiSecret     string
	validMailIDRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
)

//go:embed web/wait.html
var waitPageHTML string

//go:embed web/mirror.html
var mirrorPageHTML string

var (
	waitTemplate   = template.Must(template.New("wait").Parse(waitPageHTML))
	mirrorTemplate = template.Must(template.New("mirror").Parse(mirrorPageHTML))
)

// ============================================================================
// 模块一：Google OAuth 跨浏览器配对中继（隔离单会话 PollToken）
// ============================================================================

type OAuthSession struct {
	Code        string
	PollToken   string // 单次会话专属轮询令牌，避免暴露全局 apiSecret
	OAuthURL    string
	CallbackURL string
	CreatedAt   time.Time
}

var (
	oauthMu       sync.Mutex
	oauthSessions = make(map[string]*OAuthSession)
)

const codeCharset = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func generateCode(length int) string {
	b := make([]byte, length)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(codeCharset))))
		b[i] = codeCharset[n.Int64()]
	}
	return string(b)
}

func secureEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ============================================================================
// 模块二：Gmail 零延迟 SSE 长连接无痕镜像（并发安全 + 生命周期隔离 + 增量推送）
// ============================================================================

type MailItem struct {
	ID      string `json:"id"`
	Sender  string `json:"sender"`
	Subject string `json:"subject"`
	Snippet string `json:"snippet"`
	Time    string `json:"time"`
	Unread  bool   `json:"unread"`
}

type MailHeaders struct {
	From        string `json:"from"`
	ReplyTo     string `json:"reply_to"`
	To          string `json:"to"`
	Cc          string `json:"cc"`
	Date        string `json:"date"`
	Subject     string `json:"subject"`
	MailingList string `json:"mailing_list"`
	MailedBy    string `json:"mailed_by"`
	SignedBy    string `json:"signed_by"`
	Security    string `json:"security"`
}

type MailDelta struct {
	UpdatedAt  string       `json:"updated_at"`
	Inbox      *[]MailItem  `json:"inbox,omitempty"`
	BodyID     string       `json:"body_id,omitempty"`
	BodyHTML   string       `json:"body_html,omitempty"`
	Headers    *MailHeaders `json:"headers,omitempty"`
	OwnerEmail string       `json:"owner_email,omitempty"`
}

type MailSession struct {
	Code          string
	LastHeartbeat time.Time
	OwnerEmail    string
	Inbox         []MailItem
	ParsedBodies  map[string]string
	ParsedHeaders map[string]MailHeaders
	WantFetchID   string

	HostNotifyCh chan string
	ClientSubs   map[chan MailDelta]struct{}
	Done         chan struct{}
	closeOnce    sync.Once
}

var (
	mailMu       sync.RWMutex
	mailSessions = make(map[string]*MailSession)
)

func (s *MailSession) closeSession() {
	s.closeOnce.Do(func() {
		close(s.Done)
	})
}

func getOrCreateMailSession(code string) *MailSession {
	sess, exists := mailSessions[code]
	if !exists {
		sess = &MailSession{
			Code:          code,
			ParsedBodies:  make(map[string]string),
			ParsedHeaders: make(map[string]MailHeaders),
			HostNotifyCh:  make(chan string, 16),
			ClientSubs:    make(map[chan MailDelta]struct{}),
			Done:          make(chan struct{}),
		}
		mailSessions[code] = sess
		log.Printf("[Gmail 创建配对] Code=%s\n", code)
	}
	return sess
}

func (s *MailSession) broadcastDelta(delta MailDelta) {
	for ch := range s.ClientSubs {
		select {
		case ch <- delta:
		default:
		}
	}
}

func (s *MailSession) notifyHostFetch(mailID string) {
	if !validMailIDRe.MatchString(mailID) {
		return
	}
	select {
	case s.HostNotifyCh <- mailID:
	default:
	}
}

// ============================================================================
// 公共中间件：CORS 与鉴权
// ============================================================================

func enableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func extractBearerOrQueryToken(r *http.Request) string {
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if auth == "" {
		auth = r.URL.Query().Get("token")
	}
	return auth
}

func checkGlobalAuth(r *http.Request) bool {
	return secureEqual(extractBearerOrQueryToken(r), apiSecret)
}

// ============================================================================
// OAuth 路由处理
// ============================================================================

func handleOAuthCreate(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if !checkGlobalAuth(r) {
		http.Error(w, "Unauthorized: Invalid API Key", http.StatusUnauthorized)
		return
	}

	var req struct {
		Code     string `json:"code"`
		OAuthURL string `json:"oauth_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.OAuthURL == "" {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	code := req.Code
	if code == "" {
		code = generateCode(10)
	}

	oauthMu.Lock()
	oauthSessions[code] = &OAuthSession{
		Code:      code,
		PollToken: generateCode(24),
		OAuthURL:  req.OAuthURL,
		CreatedAt: time.Now(),
	}
	oauthMu.Unlock()

	log.Printf("[OAuth 创建配对] Code=%s\n", code)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"code": code})
}

func handleGoRedirect(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/go/")
	if code == "" {
		http.Error(w, "Missing code", http.StatusBadRequest)
		return
	}

	oauthMu.Lock()
	sess, ok := oauthSessions[code]
	oauthMu.Unlock()

	if !ok || time.Since(sess.CreatedAt) > OAuthTTL {
		http.Error(w, "配对码不存在或已过期，请在原浏览器刷新重试", http.StatusNotFound)
		return
	}

	http.Redirect(w, r, sess.OAuthURL, http.StatusFound)
}

func handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if !checkGlobalAuth(r) {
		http.Error(w, "Unauthorized: Invalid API Key", http.StatusUnauthorized)
		return
	}

	var req struct {
		Code        string `json:"code"`
		CallbackURL string `json:"callback_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}

	oauthMu.Lock()
	sess, ok := oauthSessions[req.Code]
	if ok {
		sess.CallbackURL = req.CallbackURL
	}
	oauthMu.Unlock()

	if !ok {
		http.Error(w, "Session expired or not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

func handleOAuthPoll(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	code := r.URL.Query().Get("code")
	token := extractBearerOrQueryToken(r)

	oauthMu.Lock()
	sess, ok := oauthSessions[code]
	if !ok {
		oauthMu.Unlock()
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}
	// 仅允许当前会话专属 PollToken 或全局管理员密钥轮询
	if !secureEqual(token, sess.PollToken) && !secureEqual(token, apiSecret) {
		oauthMu.Unlock()
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var callbackURL string
	if sess.CallbackURL != "" {
		callbackURL = sess.CallbackURL
		delete(oauthSessions, code) // 阅后即焚
	}
	oauthMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	if callbackURL == "" {
		w.Write([]byte(`{"ready":false}`))
		return
	}

	log.Printf("[OAuth 交付并销毁] Code=%s\n", code)
	json.NewEncoder(w).Encode(map[string]any{
		"ready":        true,
		"callback_url": callbackURL,
	})
}

// ============================================================================
// Gmail 动态配对镜像路由
// ============================================================================

func handleMailPush(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if !checkGlobalAuth(r) {
		http.Error(w, "Unauthorized: Invalid API Key", http.StatusUnauthorized)
		return
	}

	var payload struct {
		Code      string       `json:"code"`
		Close     bool         `json:"close"`
		Inbox     *[]MailItem  `json:"inbox"`      // 使用指针支持空数组清空列表
		FetchedID string       `json:"fetched_id"` // 邮件 ID
		CleanHTML *string      `json:"clean_html"` // 使用指针允许空正文清除 WantFetchID
		Headers   *MailHeaders `json:"headers"`    // 邮件头详情（发件人、收件人、投递信息等）
		Email     string       `json:"email"`      // 当前镜像的 Gmail 邮箱地址
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || !validMailIDRe.MatchString(payload.Code) || len(payload.Code) < 8 {
		http.Error(w, "Invalid payload or code", http.StatusBadRequest)
		return
	}

	mailMu.Lock()
	if payload.Close {
		if sess, ok := mailSessions[payload.Code]; ok {
			sess.closeSession()
			delete(mailSessions, payload.Code)
		}
		mailMu.Unlock()
		log.Printf("[Gmail 销毁配对] Code=%s\n", payload.Code)
		w.Write([]byte(`{"status":"closed"}`))
		return
	}

	sess := getOrCreateMailSession(payload.Code)
	sess.LastHeartbeat = time.Now()

	delta := MailDelta{
		UpdatedAt: sess.LastHeartbeat.Format("15:04:05"),
	}
	hasDelta := false

	if payload.Email != "" && sess.OwnerEmail != payload.Email {
		sess.OwnerEmail = payload.Email
		delta.OwnerEmail = payload.Email
		hasDelta = true
	}

	// 1. 仅当收件箱真实发生变化（含变为空数组）时才推送列表
	if payload.Inbox != nil {
		inbox := *payload.Inbox
		if !slices.Equal(sess.Inbox, inbox) {
			sess.Inbox = inbox
			delta.Inbox = &inbox
			hasDelta = true
		}
	}

	// 2. 只要传了 FetchedID 且 CleanHTML 非 nil（即使为空字符串）均记录并清除 WantFetchID
	if payload.FetchedID != "" && validMailIDRe.MatchString(payload.FetchedID) && payload.CleanHTML != nil {
		sess.ParsedBodies[payload.FetchedID] = *payload.CleanHTML
		if payload.Headers != nil {
			sess.ParsedHeaders[payload.FetchedID] = *payload.Headers
		}
		if sess.WantFetchID == payload.FetchedID {
			sess.WantFetchID = ""
		}
		delta.BodyID = payload.FetchedID
		delta.BodyHTML = *payload.CleanHTML
		if payload.Headers != nil {
			delta.Headers = payload.Headers
		}
		hasDelta = true
		log.Printf("[Gmail 收到正文并增量推送] Code=%s | MailID=%s\n", payload.Code, payload.FetchedID)
	}

	if hasDelta {
		sess.broadcastDelta(delta)
	}
	wantFetch := sess.WantFetchID
	mailMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"want_fetch_id": wantFetch,
	})
}

func handleMailHostEvents(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if !checkGlobalAuth(r) {
		http.Error(w, "Unauthorized: Invalid API Key", http.StatusUnauthorized)
		return
	}

	code := r.URL.Query().Get("code")
	if !validMailIDRe.MatchString(code) || len(code) < 8 {
		http.Error(w, "Invalid code", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	mailMu.Lock()
	sess := getOrCreateMailSession(code)
	sess.LastHeartbeat = time.Now()
	notifyCh := sess.HostNotifyCh
	doneCh := sess.Done
	pendingID := sess.WantFetchID
	mailMu.Unlock()

	fmt.Fprintf(w, "event: ready\ndata: connected\n\n")
	if pendingID != "" && validMailIDRe.MatchString(pendingID) {
		fmt.Fprintf(w, "event: fetch\ndata: %s\n\n", pendingID)
	}
	flusher.Flush()

	pingTicker := time.NewTicker(15 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-doneCh:
			// 会话已关闭或被销毁，立即断开旧连接
			fmt.Fprintf(w, "event: closed\ndata: session_closed\n\n")
			flusher.Flush()
			return
		case targetID := <-notifyCh:
			if validMailIDRe.MatchString(targetID) {
				fmt.Fprintf(w, "event: fetch\ndata: %s\n\n", targetID)
				flusher.Flush()
			}
		case <-pingTicker.C:
			mailMu.Lock()
			// 严格校验当前会话实例仍为活跃实例，避免误刷新同名新会话心跳
			if cur, exists := mailSessions[code]; exists && cur == sess {
				sess.LastHeartbeat = time.Now()
			} else {
				mailMu.Unlock()
				return
			}
			mailMu.Unlock()
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func handleMailData(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	code := r.URL.Query().Get("code")
	openID := r.URL.Query().Get("open_id")

	mailMu.Lock()
	sess, ok := mailSessions[code]
	if !ok {
		mailMu.Unlock()
		http.Error(w, "配对码无效或主力端已断开", http.StatusNotFound)
		return
	}

	if openID != "" && validMailIDRe.MatchString(openID) {
		if _, cached := sess.ParsedBodies[openID]; !cached {
			sess.WantFetchID = openID
			sess.notifyHostFetch(openID)
		}
	}

	// 在持有锁期间完成 JSON 序列化，彻底防止 concurrent map read and map write
	rawJSON, err := json.Marshal(map[string]any{
		"updated_at":  sess.LastHeartbeat.Format("15:04:05"),
		"inbox":       sess.Inbox,
		"bodies":      sess.ParsedBodies,
		"headers":     sess.ParsedHeaders,
		"owner_email": sess.OwnerEmail,
	})
	mailMu.Unlock()

	if err != nil {
		http.Error(w, "Internal encode error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(rawJSON)
}

func handleMailClientStream(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	code := r.URL.Query().Get("code")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	mailMu.Lock()
	sess, exists := mailSessions[code]
	if !exists {
		mailMu.Unlock()
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	// 首次建立连接时在锁内安全序列化初始全量快照
	initPayload, _ := json.Marshal(map[string]any{
		"updated_at":  sess.LastHeartbeat.Format("15:04:05"),
		"inbox":       sess.Inbox,
		"bodies":      sess.ParsedBodies,
		"headers":     sess.ParsedHeaders,
		"owner_email": sess.OwnerEmail,
	})

	subCh := make(chan MailDelta, 16)
	sess.ClientSubs[subCh] = struct{}{}
	doneCh := sess.Done
	mailMu.Unlock()

	defer func() {
		mailMu.Lock()
		if cur, ok := mailSessions[code]; ok && cur == sess {
			delete(sess.ClientSubs, subCh)
		}
		mailMu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// 推送初始快照（附带 2KB 注释冲破反向代理缓冲）
	fmt.Fprintf(w, ": %s\nevent: snapshot\ndata: %s\n\n", strings.Repeat(" ", 2048), initPayload)
	flusher.Flush()

	pingTicker := time.NewTicker(10 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-doneCh:
			fmt.Fprintf(w, "event: closed\ndata: {}\n\n")
			flusher.Flush()
			return
		case delta := <-subCh:
			deltaBytes, err := json.Marshal(delta)
			if err == nil {
				fmt.Fprintf(w, ": %s\nevent: delta\ndata: %s\n\n", strings.Repeat(" ", 2048), deltaBytes)
				flusher.Flush()
			}
		case <-pingTicker.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func handleMailWebUI(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/mail/")
	if code == "" || strings.Contains(code, "/") || !validMailIDRe.MatchString(code) {
		http.Error(w, "请通过主力浏览器生成的完整配对短链访问（例如 /mail/xxxxxxxxxxxx）", http.StatusBadRequest)
		return
	}

	mailMu.RLock()
	_, ok := mailSessions[code]
	mailMu.RUnlock()

	if !ok {
		http.Error(w, "该邮箱配对码不存在或已过期，请检查主力浏览器 Gmail 页面右下角的最新链接", http.StatusNotFound)
		return
	}

	var buf bytes.Buffer
	if err := mirrorTemplate.Execute(&buf, map[string]string{"Code": code}); err != nil {
		http.Error(w, "Render error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(buf.Bytes())
}

// ============================================================================
// 后台自动回收过期会话
// ============================================================================

func cleanupLoop() {
	for range time.Tick(30 * time.Second) {
		oauthMu.Lock()
		for k, v := range oauthSessions {
			if time.Since(v.CreatedAt) > OAuthTTL {
				delete(oauthSessions, k)
			}
		}
		oauthMu.Unlock()

		mailMu.Lock()
		for k, v := range mailSessions {
			if time.Since(v.LastHeartbeat) > MailTTL {
				v.closeSession()
				delete(mailSessions, k)
				log.Printf("[Gmail 自动过期回收] Code=%s\n", k)
			}
		}
		mailMu.Unlock()
	}
}

func main() {
	apiSecret = os.Getenv("BRIDGE_SECRET")
	if apiSecret == "" {
		log.Fatal("BRIDGE_SECRET environment variable is required")
	}

	go cleanupLoop()

	http.HandleFunc("/oauth/create", handleOAuthCreate)
	http.HandleFunc("/go/", handleGoRedirect)
	http.HandleFunc("/oauth/callback", handleOAuthCallback)
	http.HandleFunc("/oauth/poll", handleOAuthPoll)
	http.HandleFunc("/wait/", handleWaitPage)

	http.HandleFunc("/mail/push", handleMailPush)
	http.HandleFunc("/mail/events", handleMailHostEvents)
	http.HandleFunc("/mail/data", handleMailData)
	http.HandleFunc("/mail/stream", handleMailClientStream)
	http.HandleFunc("/mail/", handleMailWebUI)

	log.Printf("🚀 公网配对中继网关已启动: %s (已启用会话隔离鉴权与增量 SSE 推送)\n", ListenAddr)
	log.Fatal(http.ListenAndServe(ListenAddr, nil))
}

func handleWaitPage(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/wait/")
	if code == "" || strings.Contains(code, "/") {
		http.Error(w, "Missing code", http.StatusBadRequest)
		return
	}

	oauthMu.Lock()
	sess, ok := oauthSessions[code]
	var pollToken, oauthURL string
	if ok && time.Since(sess.CreatedAt) <= OAuthTTL {
		pollToken = sess.PollToken
		oauthURL = sess.OAuthURL
	}
	oauthMu.Unlock()

	if pollToken == "" {
		http.Error(w, "配对会话不存在或已过期，请返回原网站重新点击 Google 登录", http.StatusNotFound)
		return
	}

	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") == "" {
		scheme = "http"
	}
	shortLink := scheme + "://" + r.Host + "/go/" + code

	var buf bytes.Buffer
	if err := waitTemplate.Execute(&buf, map[string]string{
		"Code":      code,
		"ShortLink": shortLink,
		"OAuthURL":  oauthURL,
		"PollToken": pollToken, // 仅下发当前单次会话的 PollToken，绝不下发全局 apiSecret
	}); err != nil {
		http.Error(w, "Render error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(buf.Bytes())
}

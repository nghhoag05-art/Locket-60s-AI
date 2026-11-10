/* Local-only connection page for Shadowrocket. Never enter a Gemini API key here. */
(function () {
    var origin = "http://locket-ai-setup.invalid";
    var endpointKey = "LOCKET_AI_ENDPOINT";
    var tokenKey = "LOCKET_AI_TOKEN";
    var nonceKey = "LOCKET_AI_SETUP_NONCE";
    var done = false;

    function finish(status, body, extra) {
        if (done) return;
        done = true;
        var headers = {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        };
        Object.keys(extra || {}).forEach(function (key) { headers[key] = extra[key]; });
        $done({ response: { status: status, headers: headers, body: body || "" } });
    }

    function escapeHtml(value) {
        return String(value || "").replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function read(key) { return String($persistentStore.read(key) || ""); }
    function write(key, value) { return $persistentStore.write(value, key) !== false; }

    function normalizeEndpoint(value) {
        var match = /^https:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\/v1\/images\/edit\/?|\/)?$/i.exec(value);
        if (!match) return "";
        var host = match[1].toLowerCase();
        if (host.indexOf(".") < 1 || host.indexOf("..") !== -1 || host.charAt(0) === "." || host.slice(-1) === ".") return "";
        if (/^\d+(?:\.\d+){3}$/.test(host)) return "";
        if (!host.split(".").every(function (label) { return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label); })) return "";
        var port = match[2] ? Number(match[2]) : 443;
        if (port < 1 || port > 65535) return "";
        return "https://" + host + (port === 443 ? "" : ":" + port) + "/v1/images/edit";
    }

    function parseForm(text) {
        var fields = {};
        text.split("&").forEach(function (part) {
            var i = part.indexOf("=");
            var key = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
            var value = decodeURIComponent((i < 0 ? "" : part.slice(i + 1)).replace(/\+/g, " "));
            if (Object.prototype.hasOwnProperty.call(fields, key)) throw new Error("Duplicate field");
            fields[key] = value;
        });
        return fields;
    }

    function page() {
        var nonce = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
        if (!write(nonceKey, nonce)) return finish(503, "Không lưu được cấu hình trên thiết bị.");
        var current = read(endpointKey);
        var configured = Boolean(current && read(tokenKey));
        var hidden = '<input type="hidden" name="nonce" value="' + escapeHtml(nonce) + '">';
        var html = '<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Kết nối AI cho Locket</title><style>body{font:16px system-ui;margin:0;background:#faf7f0;color:#25241f}main{max-width:520px;margin:40px auto;padding:24px}h1{font-size:28px}label{display:block;margin-top:20px;font-weight:600}input{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border:1px solid #c9c5bb;border-radius:10px;font:inherit}button{padding:12px 20px;background:#bd8b23;border:0;border-radius:10px;font:inherit;color:#fff;cursor:pointer}small,p{line-height:1.55}.secondary{background:#e9e5da;color:#34312a;margin-top:12px}.status{padding:12px;border-radius:10px;background:#ede8da}</style>' +
            '<main><h1>Kết nối AI cho Locket</h1><p class="status">' + (configured ? "Đã lưu kết nối. Chưa xác nhận backend tạo ảnh thành công." : "Chưa có kết nối backend.") + '</p>' +
            '<p>Cài backend trước, rồi nhập địa chỉ HTTPS và mã kết nối do bạn đặt trên backend. API key Gemini chỉ nhập ở máy chủ.</p>' +
            '<form method="post" action="' + origin + '/save">' + hidden +
            '<label>Địa chỉ máy chủ AI<input name="endpoint" type="url" required maxlength="512" placeholder="https://ai.example.com" value="' + escapeHtml(current) + '"></label>' +
            '<label>Mã kết nối backend<input name="token" type="password" required minlength="24" maxlength="258" autocomplete="off"></label>' +
            '<small>Mã này khác token đăng nhập Locket và API key Gemini. Thông tin được lưu trong Shadowrocket trên thiết bị.</small><p><button>Lưu kết nối</button></p></form>' +
            '<form method="post" action="' + origin + '/clear">' + hidden + '<button class="secondary">Xóa kết nối đã lưu</button></form></main></html>';
        return finish(200, html);
    }

    try {
        if (typeof $response !== "undefined" || typeof $request === "undefined" || !$request) return $done({});
        var match = /^http:\/\/locket-ai-setup\.invalid(?::80)?(\/[^?#]*)?(?:\?[^#]*)?$/.exec(String($request.url || ""));
        if (!match) return $done({});
        if (typeof $persistentStore === "undefined" || !$persistentStore) return finish(503, "Shadowrocket chưa cung cấp bộ nhớ cấu hình.");
        var path = match[1] || "/";
        var method = String($request.method || "GET").toUpperCase();
        if (method === "GET" && path === "/") return page();
        if (method === "GET" && path === "/favicon.ico") return finish(204, "");
        if (method !== "POST" || (path !== "/save" && path !== "/clear")) return finish(404, "Không có trang này.");
        var headers = $request.headers || {};
        var originHeader = "";
        Object.keys(headers).forEach(function (key) { if (key.toLowerCase() === "origin") originHeader = String(headers[key]); });
        if (originHeader && originHeader !== origin && originHeader !== origin + ":80") return finish(403, "Nguồn biểu mẫu không hợp lệ.");
        if (typeof $request.body !== "string" || $request.body.length > 8192) return finish(400, "Biểu mẫu không hợp lệ.");
        var form = parseForm($request.body);
        if (!form.nonce || form.nonce !== read(nonceKey)) return finish(403, "Hãy mở lại trang cấu hình rồi thử lại.");
        if (path === "/clear") {
            if (!write(endpointKey, "") || !write(tokenKey, "") || !write(nonceKey, "")) return finish(503, "Không xóa được cấu hình.");
            return finish(303, "", { Location: origin + "/" });
        }
        var endpoint = normalizeEndpoint(String(form.endpoint || "").trim());
        var token = String(form.token || "").trim();
        if (!endpoint || !/^[A-Za-z0-9._~+\/-]{24,256}={0,2}$/.test(token)) return finish(400, "Cần địa chỉ HTTPS hợp lệ và mã kết nối tối thiểu 24 ký tự.");
        var oldEndpoint = read(endpointKey);
        var oldToken = read(tokenKey);
        if (!write(endpointKey, endpoint) || !write(tokenKey, token)) {
            write(endpointKey, oldEndpoint);
            write(tokenKey, oldToken);
            return finish(503, "Không lưu được cấu hình.");
        }
        write(nonceKey, "");
        return finish(303, "", { Location: origin + "/" });
    } catch (error) {
        return finish(400, "Không đọc được cấu hình. Hãy mở lại trang rồi thử lại.");
    }
})();

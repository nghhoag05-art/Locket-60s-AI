/* Local-only connection page for Shadowrocket. Never enter an OpenAI API key here. */
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

    function diagnosticText() {
        var messages = {
            received: "Đã nhận yêu cầu tạo ảnh từ Locket.",
            unsupported_method: "Yêu cầu ảnh chưa đúng phương thức được hỗ trợ.",
            invalid_body: "Chưa đọc được nội dung yêu cầu ảnh.",
            runtime_unavailable: "Môi trường script chưa hỗ trợ kết nối backend.",
            store_unavailable: "Script chưa đọc được cấu hình đã lưu trên thiết bị.",
            endpoint_missing: "Chưa lưu địa chỉ backend.",
            endpoint_invalid: "Địa chỉ backend đã lưu chưa hợp lệ.",
            token_missing: "Chưa lưu mã kết nối backend.",
            token_invalid: "Mã kết nối backend đã lưu chưa hợp lệ.",
            invalid_json: "Yêu cầu ảnh từ Locket chưa có định dạng được hỗ trợ.",
            image_missing: "Chưa tìm thấy địa chỉ ảnh đầu vào trong yêu cầu Locket.",
            prompt_missing: "Chưa tìm thấy mô tả hiệu ứng trong yêu cầu Locket.",
            unknown_preset: "Hiệu ứng này chưa được nhận diện.",
            unsupported_composition: "Mục này là khung/Photobooth. Backend hiện chưa ghép khung hoặc tạo bố cục nhiều ảnh.",
            invalid_images: "Danh sách ảnh chưa hợp lệ. Photobooth nhận một ảnh hoặc bốn ảnh riêng.",
            image_count_mismatch: "Số ảnh chưa phù hợp với khung đã chọn.",
            composition_required: "Danh sách nhiều ảnh chỉ dùng cho khung hoặc Photobooth.",
            composition_success: "Backend của Hoàng đã ghép ảnh vào khung và trả ảnh kết quả mới.",
            composition_single_source: "Đã ghép Photobooth từ một ảnh đầu vào. Các ô dùng lại ảnh này, không phải bốn lần chụp riêng.",
            prompt_too_long: "Mô tả hiệu ứng vượt giới hạn hỗ trợ.",
            started: "Đã gửi yêu cầu chỉnh ảnh tới backend.",
            timeout: "Backend chưa trả kết quả trong thời gian chờ.",
            transport_error: "Không kết nối được backend. Kiểm tra cửa sổ Python và URL HTTPS còn hoạt động.",
            http_error: "Backend đã trả lỗi. Cần kiểm tra cấu hình hoặc quyền sử dụng API.",
            server_image_dns_failed: "Máy chủ không phân giải được DNS của nguồn ảnh.",
            server_unsafe_image_host: "Máy chủ từ chối host ảnh vì lý do bảo mật.",
            server_unsafe_image_url: "Đường dẫn ảnh không thuộc nguồn HTTPS được cho phép.",
            server_image_download_failed: "Backend không tải được ảnh nguồn từ Locket.",
            server_unsupported_image: "Định dạng ảnh nguồn không được hỗ trợ.",
            server_invalid_image: "Dữ liệu ảnh nguồn không hợp lệ.",
            server_provider_unavailable: "Không kết nối được OpenAI hoặc OpenAI xử lý quá lâu.",
            server_provider_rate_limited: "OpenAI đang giới hạn số yêu cầu.",
            server_generation_blocked: "OpenAI từ chối tạo ảnh vì kiểm duyệt nội dung.",
            server_provider_rejected_request: "OpenAI từ chối yêu cầu: kiểm tra khóa API, quyền model hoặc quota/billing.",
            server_invalid_provider_response: "Dữ liệu ảnh trả từ OpenAI không đúng định dạng mà backend yêu cầu.",
            server_invalid_generated_image: "Ảnh trả về từ trình xử lý không hợp lệ.",
            server_not_configured: "Backend chưa cấu hình đủ API key, token kết nối và URL HTTPS.",
            server_unauthorized: "Mã kết nối backend không đúng hoặc đã thay đổi.",
            server_invalid_content_type: "Yêu cầu gửi tới backend có Content-Type không đúng.",
            server_invalid_request: "Dữ liệu yêu cầu gửi tới backend không hợp lệ.",
            server_request_too_large: "Yêu cầu gửi tới backend quá lớn.",
            server_invalid_json: "Backend không đọc được JSON của yêu cầu.",
            server_invalid_input: "Backend từ chối định dạng dữ liệu ảnh hoặc mô tả hiệu ứng.",
            server_backend_busy: "Backend đang xử lý ảnh khác.",
            server_backend_rate_limited: "Backend đã đạt giới hạn số lần xử lý mỗi phút.",
            server_internal_error: "Backend gặp lỗi nội bộ.",
            server_not_found: "Đường dẫn API backend không tồn tại.",
            server_invalid_composition: "Thông số ghép khung chưa hợp lệ.",
            server_unsupported_composition: "Khung hoặc Photobooth này chưa được backend hỗ trợ.",
            invalid_response: "Phản hồi backend chưa đúng định dạng.",
            invalid_output: "Backend chưa trả địa chỉ ảnh đầu ra hợp lệ.",
            unchanged_output: "Backend trả lại địa chỉ ảnh đầu vào; script không báo tạo ảnh AI thành công.",
            success: "Backend đã trả một ảnh kết quả mới. Cần kiểm tra ảnh hiển thị trong Locket.",
            runtime_error: "Script gặp lỗi khi xử lý yêu cầu ảnh."
        };
        try {
            var status = JSON.parse(read("LOCKET_AI_STATUS"));
            if (status && typeof status === "object" && Object.prototype.hasOwnProperty.call(messages, status.code)) {
                return messages[status.code];
            }
        } catch (error) {}
        return "Chưa ghi nhận yêu cầu tạo ảnh. Mở Locket và thử chọn một hiệu ứng.";
    }

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
            '<p class="status">' + (read("LOCKET_AI_CATALOG_VERSION") === "hoang-own-ai-ptb-v1" ? "Đã áp dụng AI và Photobooth Hoàng gồm 83 mục. Tài nguyên được tải từ repo của Hoàng." : "Chưa ghi nhận danh mục Hoàng mới. Cập nhật module rồi đóng và mở lại Locket để tải cấu hình.") + '</p>' +
            '<p class="status">' + escapeHtml(diagnosticText()) + '</p>' +
            '<p>Chạy backend Python trên máy tính, rồi nhập địa chỉ HTTPS và mã kết nối hiện trong cửa sổ backend. API key OpenAI chỉ nhập ở máy tính.</p>' +
            '<form method="post" action="' + origin + '/save">' + hidden +
            '<label>Địa chỉ máy chủ AI<input name="endpoint" type="url" required maxlength="512" placeholder="https://ai.example.com" value="' + escapeHtml(current) + '"></label>' +
            '<label>Mã kết nối backend<input name="token" type="password" required minlength="24" maxlength="258" autocomplete="off"></label>' +
            '<small>Mã này khác token đăng nhập Locket và API key OpenAI. Thông tin được lưu trong Shadowrocket trên thiết bị.</small><p><button>Lưu kết nối</button></p></form>' +
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
        // Safari may send Origin: null for a locally synthesized Shadowrocket page.
        // Allow this opaque origin only alongside the one-time nonce check below.
        if (originHeader && originHeader !== origin && originHeader !== origin + ":80" && originHeader !== "null") return finish(403, "Nguồn biểu mẫu không hợp lệ.");
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

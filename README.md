# Locket-60s AI — backend chỉnh sửa ảnh

![Ảnh giới thiệu Zalo](assets/zalo-intro.png)

Giữ dữ liệu của Hoàng: 60 giây, 219 caption, bộ lọc, ảnh/lời giới thiệu Zalo và YouTube. Phần ảnh được viết lại để gọi Gemini qua backend riêng.

**Trạng thái:** kiểm thử cục bộ bằng phản hồi mô phỏng; chưa có API key, chưa triển khai backend HTTPS, chưa xác nhận trên iPhone. Cài module riêng lẻ chưa tạo được ảnh AI. Khi thiếu cấu hình hoặc backend lỗi, script giữ yêu cầu gốc cho Locket xử lý.

## Luồng mới

URL ảnh + prompt → backend của bạn → Gemini → ảnh kết quả lưu trên backend → URL ảnh mới trả về Locket.

Script chỉ gửi URL ảnh và prompt bằng mã kết nối backend, không chuyển token đăng nhập Locket. Chỉ trả thành công sau khi backend trả URL ảnh hợp lệ. URL ảnh kết quả là đường dẫn ngẫu nhiên; người có link có thể xem ảnh đến khi hết hạn, mặc định 15 phút.

## 1. Chạy backend

Cần Node.js 22 trở lên, không cần thư viện npm bên ngoài:

```powershell
Copy-Item .env.example .env
```

Điền trên máy chủ riêng:

| Biến | Nội dung |
| --- | --- |
| `GEMINI_API_KEY` | Key Gemini từ [Google AI Studio](https://aistudio.google.com/apikey). |
| `BACKEND_ACCESS_TOKEN` | Mã kết nối riêng, tối thiểu 24 ký tự; nên dùng chuỗi ngẫu nhiên dài. |
| `PUBLIC_BASE_URL` | HTTPS origin của backend, ví dụ `https://ai.example.com`. |
| `GEMINI_IMAGE_MODEL` | Mặc định `gemini-3.1-flash-image`; tài khoản phải có quyền/quota dùng model. |

Tạo mã kết nối trên máy, không commit kết quả:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm start
```

Backend nghe HTTP ở cổng 8787. Triển khai sau reverse proxy có HTTPS và đặt `PUBLIC_BASE_URL` thành tên miền đó. Hosting có biến môi trường sẵn thì chạy `node backend/server.mjs`. Repo có Dockerfile; thư mục lưu ảnh phải có quyền ghi.

`GET /health` cho biết `configured`; thiếu key/token/URL thì `configured:false` và API chỉnh ảnh trả 503. API key chỉ ở backend. Không nhập key Gemini vào module, trang kết nối hoặc GitHub. `.env`, `data/` và log được bỏ qua bởi Git.

## 2. Kết nối trên Shadowrocket

Thêm hoặc làm mới module:

https://raw.githubusercontent.com/nghhoag05-art/Locket-60s-AI/main/module/locket-60s-ai-youtube.module

Bật HTTPS Decryption/CA đang dùng. Chỉ bật một module Locket để tránh trùng quy tắc.

Sau khi backend hoạt động, mở địa chỉ này trên điện thoại đang chạy Shadowrocket:

`http://locket-ai-setup.invalid/`

Đây là trang được script trả trực tiếp trên thiết bị. Nhập địa chỉ HTTPS backend và `BACKEND_ACCESS_TOKEN`; hai giá trị được lưu trong Shadowrocket. Không có trường nhập API key Gemini. Có nút xóa kết nối đã lưu.

## Phạm vi hỗ trợ

- URL ảnh từ các trường được nhận diện như `imageUrl`, `image_url`, `inputUrl`, `url` và một số trường trong `data`.
- Prompt từ `prompt`, `text_prompt`, `instruction`; nếu thiếu, hỗ trợ 11 ID filter có prompt dựng sẵn trong script. Schema/ID chưa biết đi qua nguyên trạng.
- Backend tải PNG/JPEG/WebP qua HTTPS từ ba host mặc định: `firebasestorage.googleapis.com`, `storage.googleapis.com`, `cdn.locketcamera.com`. Không theo redirect. Chỉ bổ sung host ảnh tin cậy đã quan sát vào `INPUT_IMAGE_HOSTS`.

## Kiểm thử và giới hạn

```powershell
npm test
```

Kiểm thử không gọi Gemini hoặc tạo phí: dùng dữ liệu giả lập cho adapter, tải/lưu ảnh, auth, giới hạn dữ liệu, timeout, lỗi provider, script và trang kết nối.

Chưa có API key và backend HTTPS nên chưa kiểm tra tạo ảnh thật. Chưa có request/response thu từ iPhone; schema Locket hoặc cách ứng dụng nhận kết quả có thể khác với mã hiện tại. Đây chưa phải xác nhận chạy thành công trong ứng dụng.

Cấu hình 60 giây vẫn phụ thuộc giới hạn app/server. Gold là dữ liệu mô phỏng. YouTube tiếp tục dùng Maasea/sgmodule và chưa được thử trên iPhone ở lần sửa này. Dữ liệu Firebase, caption và ảnh Zalo giữ nguyên.

Nguồn: [SOURCES.md](SOURCES.md). Mã kiểm tra: `SHA256SUMS.txt`.

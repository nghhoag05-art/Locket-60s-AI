# Nguồn và phạm vi

- Nền cá nhân: `nghhoag05-art/Locket-60s-AI`, commit `a4f6ec7c18ff7d048ef617c69c792d5cc026d87f`. Các file cấu hình Locket, header, RevenueCat và ảnh giữ nguyên bytes.
- Bản trước tham khảo nhánh phản hồi ảnh đầu vào của Hakaiz/dinhtuan07, repo `dtuandzxyz/Locket-Filter-Module`, commit `9c2ea58aaea3f6d9258b60d3cf1621ea6a4ccdce`. Bản mới thay handler mô phỏng bằng client/backend riêng; không dùng Worker, đồng bộ UID hay sửa hồ sơ của nguồn đó.
- Cấu trúc kết quả `result.outputUrl` và các trường tương thích được giữ để thử với Locket; chưa có xác nhận runtime trên iPhone.
- Gemini: [generateContent](https://ai.google.dev/api/generate-content), [tạo/chỉnh sửa ảnh](https://ai.google.dev/gemini-api/docs/image-generation), [Firebase AI Logic](https://firebase.google.com/docs/ai-logic/generate-images-gemini?hl=en). Giữ thiết lập an toàn mặc định của provider.
- API script: [Surge API](https://manual.nssurge.com/scripting/api.html), [HTTP request](https://manual.nssurge.com/scripting/http-request.html). Shadowrocket vẫn cần kiểm tra thiết bị.
- YouTube: [Maasea/sgmodule](https://github.com/Maasea/sgmodule), Apache-2.0; hai script tiếp tục tải từ upstream.
- Ảnh do người dùng cung cấp, giữ nguyên PNG đã công khai theo xác nhận.

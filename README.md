# Locket-60s AI — Hoàng

![Ảnh giới thiệu Zalo](assets/zalo-intro.png)

Bản riêng dựa trên dữ liệu của Hoàng trong [Locket-60s](https://github.com/nghhoag05-art/Locket-60s), giữ cấu hình 60 giây, các ghi chú, bộ lọc, thông tin Zalo và phần YouTube.

## Thêm vào Shadowrocket

Dùng URL module:

https://raw.githubusercontent.com/nghhoag05-art/Locket-60s-AI/main/module/locket-60s-ai-youtube.module

Trong Shadowrocket, vào Cấu hình → cấu hình đang dùng → Module → + và dán URL. Tắt các module Locket/YouTube cũ trùng chức năng, bật HTTPS Decryption với CA đang dùng, làm mới module/script rồi mở lại ứng dụng.

## Phần AI thử nghiệm hoạt động thế nào?

Người dùng đã chọn ghép thử mã Hakaiz và chấp nhận có thể chỉ nhận ảnh gốc.

- Chỉ tách nhánh xử lý request `generateFilteredImage` từ nguồn Hakaiz/dinhtuan07.
- Với URL ảnh được nhận diện, script tạo phản hồi thành công chứa **chính URL ảnh đầu vào**. Script không tạo ảnh AI mới.
- Nếu không nhận diện body hoặc URL, request đi qua nguyên trạng. Điều này không cấp quyền AI trên máy chủ Locket.
- Không sao chép catalogue/ghi chú/khung ảnh của Hakaiz; không ghép đồng bộ UID, sửa hồ sơ, cộng đồng VIP, Photobooth hay đoạn xóa lỗi từ response.
- Không thêm dịch vụ AI bên ngoài hoặc API key.

## Dữ liệu cá nhân và ảnh

Tên, lời giới thiệu và số Zalo trong popup giữ từ script của Hoàng. Ảnh đã chọn được đặt vào `feature_discovery_popup_config.feature_set[0].imageURL` và lưu ở `assets/zalo-intro.png`.

Ảnh nguồn đã kiểm tra là PNG tại:
https://i.postimg.cc/26JD782q/Screenshot-2026-11-10-021543.png

Cách Locket hiển thị/cắt ảnh trong popup chưa được kiểm tra trên iPhone.

## Giới hạn

- 22 giá trị thời lượng được đặt thành 60 giây; ứng dụng hoặc máy chủ vẫn có thể áp giới hạn khác.
- Gold trong script là dữ liệu mô phỏng, không tạo giao dịch mua.
- Phần tạo ảnh thử nghiệm trả ảnh đầu vào, không phải một công cụ tạo ảnh AI thật.
- YouTube sử dụng Maasea/sgmodule; upstream kiểm thử cho Surge, chưa xác nhận thực tế trên iPhone/Shadowrocket ở bản ghép này.
- Cấu hình Firebase giữ cách xử lý hiện có, gồm giới hạn cache `NO_CHANGE` và việc thay nguyên khối một số JSON lồng.

## Nguồn

Xem [SOURCES.md](SOURCES.md) để đối chiếu nguồn và phạm vi tách mã. `SHA256SUMS.txt` kiểm tra các file trong repo.

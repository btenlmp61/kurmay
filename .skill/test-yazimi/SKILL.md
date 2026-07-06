---
name: test-yazimi
description: Yazılan kod için hızlı doğrulama veya test eklerken uygulanacak yöntem
---

# Test yazımı

Kod yazdıktan sonra çalıştığını doğrularken şu sırayı izle:

1. **En ucuz doğrulama önce**: derleme/sözdizimi kontrolü (`node --check`, `npx tsc --noEmit` vb.) her zaman ilk adım.
2. **Davranış doğrulaması**: değiştirdiğin fonksiyonun ana yolunu ve bir uç durumunu kapsayan küçük bir çalıştırma yap (geçici script veya mevcut test komutu).
3. **Test dosyası ekleyeceksen**: projedeki mevcut test düzenini taklit et; test çerçevesi yoksa bağımlılık EKLEME, çalıştırılabilir basit bir doğrulama scripti yaz.
4. Testin çıktısını raporunda "Doğrulama" bölümüne aynen aktar — "çalışıyor" deme, kanıt göster.

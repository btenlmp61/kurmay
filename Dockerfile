FROM node:22-alpine

WORKDIR /app

# Bağımlılıklar (cache dostu: önce sadece manifest dosyaları)
COPY package.json package-lock.json ./
RUN npm ci

# Kaynak kod
COPY . .

# Derleme adımı yok (tsx ile doğrudan çalıştırılıyor); tip kontrolü erken hata yakalar
RUN npm run typecheck

EXPOSE 4141

# CMD boş bırakılır: argümanlar `docker run` veya compose `command:` ile eklenir
# (örn. --cwd /workspace/target --port 4141). Argümansız çalışırsa sunucu modu
# açılır ve config.json'daki targetDir kullanılır.
ENTRYPOINT ["npx", "tsx", "src/index.ts"]
CMD []

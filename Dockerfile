FROM node:20-alpine

WORKDIR /app

# Install git for cloning iptv-org/epg
RUN apk add --no-cache git curl

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Set data directory
ENV DB_DIR=/app/data
ENV PORT=3000

# Create data directory
RUN mkdir -p $DB_DIR

# Clone iptv-org/epg repo for grabber functionality
RUN git clone --depth 1 https://github.com/iptv-org/epg.git $DB_DIR/iptv-org-epg && \
    cd $DB_DIR/iptv-org-epg && npm install

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["npm", "start"]

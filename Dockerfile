# Use Node.js 22 LTS as base image
FROM node:22-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files first (for better layer caching)
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src/ ./src/

# Expose port 3000 for the API
EXPOSE 3000

# Default command (can be overridden in docker-compose)
CMD ["npm", "start"]

FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* yarn.lock* ./

# Install dependencies
RUN npm install

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Start the server
CMD ["npm", "start"]

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy WebSocket connections to gateway during local dev
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});

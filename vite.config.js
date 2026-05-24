import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // relativní cesty – nutné, aby Electron našel soubory přes file://
  base: "./",
  server: {
    open: true,
  },
});

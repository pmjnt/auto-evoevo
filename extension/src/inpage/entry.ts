import { installProvider } from "./provider.js";

if (typeof window !== "undefined") {
  installProvider();
}

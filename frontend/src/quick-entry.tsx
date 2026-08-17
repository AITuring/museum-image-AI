import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QuickEntryPage } from "./features/quick-entry/QuickEntryPage"
import "./index.css"

const apiBaseUrl = (import.meta.env.VITE_QUICK_ENTRY_API_BASE_URL ?? "").replace(/\/$/, "")
const configuredToken = import.meta.env.VITE_QUICK_ENTRY_TOKEN ?? ""

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QuickEntryPage apiBaseUrl={apiBaseUrl} configuredToken={configuredToken} />
  </StrictMode>,
)

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App as AntApp, ConfigProvider } from "antd"
import zhCN from "antd/locale/zh_CN"
import "antd/dist/reset.css"
import "./index.css"
import App from "./App.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        cssVar: { prefix: "museum" },
        token: {
          colorPrimary: "#111111",
          colorSuccess: "#2f8f57",
          colorWarning: "#ad7a17",
          colorError: "#d14343",
          colorBgLayout: "#f6f6f4",
          colorBgContainer: "#ffffff",
          colorText: "#151515",
          colorTextSecondary: "#5f605f",
          borderRadius: 10,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Button: {
            borderRadius: 8,
            controlHeight: 32,
            defaultShadow: "none",
            primaryShadow: "none",
          },
          Input: {
            controlHeight: 32,
            activeBorderColor: "rgba(0, 0, 0, 0.18)",
            activeShadow: "0 0 0 2px rgba(17, 17, 17, 0.04)",
            hoverBorderColor: "rgba(0, 0, 0, 0.14)",
          },
          Select: {
            controlHeight: 32,
            activeBorderColor: "rgba(0, 0, 0, 0.18)",
            activeOutlineColor: "rgba(17, 17, 17, 0.04)",
            hoverBorderColor: "rgba(0, 0, 0, 0.14)",
          },
          Card: {
            headerBg: "#ffffff",
          },
          Tabs: {
            cardBg: "#f7f7f5",
            itemActiveColor: "#111111",
            itemColor: "#5f605f",
            itemHoverColor: "#111111",
          },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
)

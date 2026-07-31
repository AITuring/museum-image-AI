import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App as AntApp, ConfigProvider } from "antd"
import zhCN from "antd/locale/zh_CN"
import "antd/dist/reset.css"
import "./index.css"
import App from "./App"
import { OperationHistoryProvider } from "./OperationHistory"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        cssVar: { prefix: "museum" },
        token: {
          colorPrimary: "#70543b",
          colorSuccess: "#48745b",
          colorWarning: "#a56c23",
          colorError: "#b94d45",
          // antd 的 colorLink 不跟随 colorPrimary，不显式覆盖会留下默认的蓝色链接。
          colorLink: "#70543b",
          colorLinkHover: "#8d7054",
          colorLinkActive: "#503824",
          colorBgLayout: "#f3f0ea",
          colorBgContainer: "#fffdf9",
          colorText: "#24221f",
          colorTextSecondary: "#66615a",
          colorBorder: "#d9d2c8",
          colorBorderSecondary: "#e8e2d9",
          // 与 index.css 的 --ui-radius-* 一一对应：控件 10、分块 12、标签 6。
          borderRadius: 10,
          borderRadiusLG: 12,
          borderRadiusSM: 10,
          borderRadiusXS: 6,
          controlHeight: 36,
          controlHeightSM: 32,
          fontSize: 14,
          fontSizeSM: 12,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Button: {
            borderRadius: 10,
            borderRadiusSM: 10,
            controlHeight: 36,
            controlHeightSM: 32,
            defaultBg: "#f1ece4",
            defaultBorderColor: "transparent",
            defaultHoverBg: "#e8e0d5",
            defaultHoverBorderColor: "transparent",
            defaultHoverColor: "#302b26",
            defaultActiveBg: "#ddd3c7",
            defaultActiveBorderColor: "transparent",
            defaultActiveColor: "#24221f",
            defaultShadow: "none",
            primaryShadow: "none",
            fontWeight: 600,
          },
          Input: {
            controlHeight: 36,
            activeBorderColor: "#8d7054",
            activeShadow: "0 0 0 3px rgba(112, 84, 59, 0.10)",
            hoverBorderColor: "#b7a694",
          },
          Select: {
            controlHeight: 36,
            activeBorderColor: "#8d7054",
            activeOutlineColor: "rgba(112, 84, 59, 0.10)",
            hoverBorderColor: "#b7a694",
          },
          Card: {
            borderRadiusLG: 12,
            bodyPadding: 20,
            bodyPaddingSM: 16,
            headerHeight: 50,
            headerHeightSM: 44,
            headerBg: "#fffdf9",
          },
          Checkbox: {
            borderRadiusSM: 6,
          },
          Segmented: {
            borderRadius: 10,
            borderRadiusSM: 10,
            borderRadiusXS: 7,
            itemActiveBg: "#fffdf9",
            itemHoverBg: "#ebe4db",
            trackBg: "#f1ece4",
          },
          Tag: {
            borderRadiusSM: 6,
            defaultBg: "#f1ede6",
          },
          Tabs: {
            cardBg: "#f1ede6",
            itemActiveColor: "#4f3928",
            itemColor: "#6b655e",
            itemHoverColor: "#4f3928",
            inkBarColor: "#70543b",
          },
        },
      }}
    >
      <AntApp>
        <OperationHistoryProvider>
          <App />
        </OperationHistoryProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
)

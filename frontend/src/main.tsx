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
          colorPrimary: "#147f79",
          colorSuccess: "#48745b",
          colorWarning: "#a56c23",
          colorError: "#b94d45",
          // 链接、主操作与焦点反馈统一使用 Logo 中的绿松石色。
          colorLink: "#147f79",
          colorLinkHover: "#0f716c",
          colorLinkActive: "#084a47",
          colorBgLayout: "#ffffff",
          colorBgContainer: "#ffffff",
          colorText: "#202124",
          colorTextSecondary: "#5f6368",
          colorBorder: "#d7dade",
          colorBorderSecondary: "#eceef0",
          // 与 index.css 的 --ui-radius-* 一一对应：控件 8、分块 10、标签 4。
          borderRadius: 8,
          borderRadiusLG: 10,
          borderRadiusSM: 8,
          borderRadiusXS: 4,
          controlHeight: 36,
          controlHeightSM: 32,
          fontSize: 14,
          fontSizeSM: 12,
          fontFamily:
            '"Avenir Next", "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Button: {
            borderRadius: 8,
            borderRadiusSM: 8,
            controlHeight: 36,
            controlHeightSM: 32,
            defaultBg: "#f4f5f6",
            defaultBorderColor: "transparent",
            defaultHoverBg: "#e9ebed",
            defaultHoverBorderColor: "transparent",
            defaultHoverColor: "#202124",
            defaultActiveBg: "#dfe2e5",
            defaultActiveBorderColor: "transparent",
            defaultActiveColor: "#202124",
            defaultShadow: "none",
            primaryShadow: "none",
            fontWeight: 600,
          },
          Input: {
            controlHeight: 36,
            activeBorderColor: "#147f79",
            activeShadow: "0 0 0 3px rgba(20, 127, 121, 0.13)",
            hoverBorderColor: "#5da7a2",
          },
          Select: {
            controlHeight: 36,
            activeBorderColor: "#147f79",
            activeOutlineColor: "rgba(20, 127, 121, 0.13)",
            hoverBorderColor: "#5da7a2",
          },
          Card: {
            borderRadiusLG: 10,
            bodyPadding: 20,
            bodyPaddingSM: 16,
            headerHeight: 50,
            headerHeightSM: 44,
            headerBg: "#ffffff",
          },
          Checkbox: {
            borderRadiusSM: 6,
          },
          Segmented: {
            borderRadius: 8,
            borderRadiusSM: 8,
            borderRadiusXS: 6,
            itemActiveBg: "#d9efed",
            itemHoverBg: "#edf8f7",
            itemSelectedBg: "#edf8f7",
            itemSelectedColor: "#084a47",
            trackBg: "#f1f2f4",
          },
          Tag: {
            borderRadiusSM: 4,
            defaultBg: "#f1f2f4",
          },
          Tabs: {
            cardBg: "#f1f2f4",
            itemActiveColor: "#0b5f5b",
            itemColor: "#676b70",
            itemHoverColor: "#147f79",
            inkBarColor: "#147f79",
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

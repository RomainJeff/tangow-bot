import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { WidgetBlockView } from "../../src/pages/shell/widget-block";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: {} });
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mx-auto max-w-thread">
        <WidgetBlockView
          block={{ kind: "widget", title: "Launch overview", artifactId: "widget-1" }}
          artifactTarget={{ botId: "bot-1" }}
        />
      </div>
    </main>
  </I18nProvider>,
);

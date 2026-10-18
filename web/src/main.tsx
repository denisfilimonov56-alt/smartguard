import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { CloudField } from "./ui/CloudField";
import { TourProvider } from "./features/tour/Tour";
import { AuthProvider } from "./state/auth";
import { CatalogProvider } from "./state/catalog";
import { DialogProvider } from "./ui/Dialogs";
import { CrashCard, ErrorBoundary } from "./ui/ErrorBoundary";
import { MenuProvider } from "./ui/Menu";
import { ToastProvider } from "./ui/Toasts";
import "./styles.css";
import "./ui/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Точечный фон с плывущими облаками под всеми экранами, включая вход. */}
    <CloudField />
    {/* Последний рубеж: ошибки разделов и окон ловят их собственные границы (App.tsx,
        ui/Dialogs.tsx); сюда доходит только сбой каркаса — вместо белой страницы объяснение. */}
    <ErrorBoundary fallback={(error) => (
      <div className="login-page">
        <CrashCard title="Интерфейс не удалось показать" error={error}
          hint="Обновите страницу. Если ошибка повторяется, сообщите администратору текст ниже.">
          <button type="button" className="btn primary" onClick={() => location.reload()}>Обновить страницу</button>
        </CrashCard>
      </div>
    )}>
      <ToastProvider>
        {/* Всё, что ниже, существует только после входа: выход размонтирует
            каталог, и данные прежнего пользователя не остаются в памяти страницы. */}
        <AuthProvider>
          <CatalogProvider>
            <DialogProvider>
              <MenuProvider>
                {/* Обучение поверх разделов: ему нужны и вошедший, и каталог. */}
                <TourProvider>
                  <App />
                </TourProvider>
              </MenuProvider>
            </DialogProvider>
          </CatalogProvider>
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);

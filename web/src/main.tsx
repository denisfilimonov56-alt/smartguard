import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AuthProvider } from "./state/auth";
import { CatalogProvider } from "./state/catalog";
import { DialogProvider } from "./ui/Dialogs";
import { MenuProvider } from "./ui/Menu";
import { ToastProvider } from "./ui/Toasts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      {/* Всё, что ниже, существует только после входа: выход размонтирует
          каталог, и данные прежнего пользователя не остаются в памяти страницы. */}
      <AuthProvider>
        <CatalogProvider>
          <DialogProvider>
            <MenuProvider>
              <App />
            </MenuProvider>
          </DialogProvider>
        </CatalogProvider>
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);

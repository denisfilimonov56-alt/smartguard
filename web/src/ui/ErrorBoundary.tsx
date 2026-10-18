import { Component, type ErrorInfo, type ReactNode } from "react";

/* Ошибка рендера в одном разделе или окне не должна ронять всё приложение:
   без границы React размонтирует корень, остаётся белая страница, а вместе
   с ней пропадает несохранённый ввод в остальных местах. Граница ловит
   ошибку своего поддерева и показывает вместо него заглушку; остальное
   приложение работает дальше. Сбросить — key на границе (новый раздел,
   новое окно) или кнопка «Попробовать снова». */

interface Props {
  children: ReactNode;
  /** Своя заглушка; по умолчанию — карточка с текстом ошибки и кнопкой «Попробовать снова». */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Где случилась ошибка — для заголовка заглушки. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Ошибка интерфейса", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <CrashCard title={this.props.label ? `Не удалось показать: ${this.props.label}` : undefined}
      error={error} onRetry={this.reset} />;
  }
}

/** Карточка ошибки: что случилось и что сделать. */
export function CrashCard({ title = "Не удалось показать этот раздел", hint, error, onRetry, children }: {
  title?: string; hint?: string; error: Error; onRetry?: () => void; children?: ReactNode;
}) {
  return (
    <div className="card pad crash" role="alert">
      <span className="badge warn">Ошибка интерфейса</span>
      <h3>{title}</h3>
      <p className="muted">
        {hint ?? "Остальные разделы работают. Если ошибка повторяется, обновите страницу и сообщите администратору текст ниже."}
      </p>
      <pre className="crash-text">{error.message || String(error)}</pre>
      <div className="row">
        {onRetry && <button type="button" className="btn primary" onClick={onRetry}>Попробовать снова</button>}
        {children}
      </div>
    </div>
  );
}

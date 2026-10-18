import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { useCheckForm, useCheckFormControl, type CheckForm } from "../../state/checkForm";
import { Spinner } from "../../ui/common";
import { errorText, useToast } from "../../ui/Toasts";
import { stepsFor, type Step, type TourContext } from "./steps";

/* Обучение по интерфейсу: пошаговый путеводитель поверх живых разделов.
   На каждом шаге подсвечивается настоящий элемент, рядом — карточка
   с пояснением; путеводитель сам переключает разделы, открывает панель
   правила и запускает проверку примера. Запускается после первого входа
   (отметка хранится у пользователя на сервере) и повторно — из меню
   пользователя. Escape и «Пропустить» закрывают его и тоже ставят отметку. */

/** Поля формы проверки, которые меняют шаги обучения (steps.tsx: check-form, check-result, check-batch). */
const TOUR_FIELDS = ["mode", "goal", "result", "checked"] as const;
type TourField = typeof TOUR_FIELDS[number];
const pickTourFields = (form: CheckForm) =>
  Object.fromEntries(TOUR_FIELDS.map((k) => [k, form[k]])) as Pick<CheckForm, TourField>;

interface TourState {
  active: boolean;
  /** Шаг про боковую панель: держать её раскрытой. */
  pinSide: boolean;
  start: () => void;
}

const Context = createContext<TourState>({ active: false, pinSide: false, start: () => {} });
export const useTour = () => useContext(Context);

/** Интерфейс рассчитан на настольный экран: уже этой ширины вместо него заглушка (styles.css, .too-narrow). */
const MIN_WIDTH = 1100;
/** Сколько ждать появления элемента шага после переключения раздела. */
const LOCATE_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Видимый элемент по селектору шага; скрытые (display:none) не считаются. Селектор, который
    браузер не понимает, — то же, что элемента нет: карточка встанет по центру, а не зависнет. */
function find(selector: string): HTMLElement | null {
  try {
    return [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.getClientRects().length > 0) ?? null;
  } catch {
    return null;
  }
}

export function TourProvider({ children }: { children: ReactNode }) {
  // Форма проверки живёт в своём контексте (state/checkForm.tsx); шагам она нужна рядом с каталогом.
  // Без подписки на изменения: checkForm читается в момент действия, и ввод в форму
  // не перерисовывает обучение (а с ним и всё, что под ним). Карточку шага, которая
  // показывает состояние формы, перерисовывает Overlay — он подписан сам.
  const catalogState = useCatalog();
  const form = useCheckFormControl();
  const catalog = useMemo(() => ({
    ...catalogState,
    get checkForm() { return form.get(); },
    setCheckForm: form.set,
  }), [catalogState, form]);
  const auth = useAuth();
  const toast = useToast();
  const [steps, setSteps] = useState<Step[]>([]);
  const [index, setIndex] = useState<number | null>(null);
  // Обучение идёт: шаги проверяют это после долгих запросов.
  const running = useRef(false);
  const active = useCallback(() => running.current, []);
  // Контекст шагов читается в момент действия, а не при его описании:
  // данные каталога и форма проверки за время обучения меняются.
  const ctx = useRef<TourContext>({ catalog, auth, active });
  ctx.current = { catalog, auth, active };
  // Форма проверки пользователя до обучения: шаги подставляют в неё пример и проверяют его,
  // а после обучения возвращается то, что пользователь ввёл и получил. Возвращаются только
  // поля, которые меняют шаги (TOUR_FIELDS): пакет, закончившийся за время обучения,
  // строки таблицы, подразделение и признак студента остаются как есть.
  const savedForm = useRef<Pick<CheckForm, TourField> | null>(null);

  const start = useCallback(() => {
    if (!running.current) savedForm.current = pickTourFields(ctx.current.catalog.checkForm);
    running.current = true;
    setSteps(stepsFor(auth));
    setIndex(0);
  }, [auth]);

  // Первый вход: обучение начинается, когда каталог загрузился, — иначе
  // подсвечивать нечего. На узком экране не начинается: там заглушка.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (auth.tourSeen || autoStarted.current || catalog.apiState !== "online" || innerWidth < MIN_WIDTH) return;
    autoStarted.current = true;
    start();
  }, [auth.tourSeen, catalog.apiState, start]);

  const leave = useCallback((i: number) => { steps[i]?.after?.(ctx.current); }, [steps]);

  const finish = useCallback((completed: boolean) => {
    if (index !== null) leave(index);
    setIndex(null);
    running.current = false;
    if (savedForm.current) ctx.current.catalog.setCheckForm(savedForm.current);
    savedForm.current = null;
    if (!auth.tourSeen) auth.markTourSeen();
    // Пройденное до конца обучение возвращает на главный экран; прерванное — оставляет, где было.
    if (completed) catalog.setSection("check");
  }, [index, leave, auth, catalog]);

  const go = useCallback((to: number) => {
    if (index === null) return;
    if (to >= steps.length) { finish(true); return; }
    leave(index);
    setIndex(Math.max(0, to));
  }, [index, steps.length, leave, finish]);

  const step = index === null ? null : steps[index];
  const value = useMemo<TourState>(() => ({ active: !!step, pinSide: !!step?.side, start }), [step, start]);

  return (
    <Context.Provider value={value}>
      {children}
      {step && index !== null && (
        <Overlay key={index} step={step} index={index} total={steps.length} ctx={ctx}
          onNext={() => go(index + 1)} onBack={() => go(index - 1)} onSkip={() => finish(false)}
          onError={(err) => toast(errorText(err), "err")} />
      )}
    </Context.Provider>
  );
}

interface Rect { top: number; left: number; width: number; height: number }
const PAD = 8;
const GAP = 14;
const MARGIN = 12;
/** Сколько ждать блок, который ещё готовится (pending): проверка на модели может думать долго. */
const PENDING_MS = 180_000;

type Place = "right" | "left" | "bottom" | "top";

/** Положение блока размером w×h рядом с подсветкой: где есть место, в порядке предпочтения;
    без подсветки — по центру; если места нет нигде — в правом нижнем углу. */
function placeNear(w: number, h: number, rect: Rect | null, prefer?: Place) {
  const clamp = (left: number, top: number) => ({
    left: Math.max(MARGIN, Math.min(left, innerWidth - w - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, innerHeight - h - MARGIN)),
  });
  if (!rect) return clamp((innerWidth - w) / 2, (innerHeight - h) / 2);
  const fits: Record<Place, boolean> = {
    right: rect.left + rect.width + GAP + w <= innerWidth - MARGIN,
    left: rect.left - GAP - w >= MARGIN,
    bottom: rect.top + rect.height + GAP + h <= innerHeight - MARGIN,
    top: rect.top - GAP - h >= MARGIN,
  };
  const order: Place[] = prefer ? [prefer, "right", "bottom", "left", "top"] : ["right", "bottom", "left", "top"];
  const side = order.find((p) => fits[p]);
  const centerY = rect.top + rect.height / 2 - h / 2;
  const centerX = rect.left + rect.width / 2 - w / 2;
  return side === "right" ? clamp(rect.left + rect.width + GAP, centerY)
    : side === "left" ? clamp(rect.left - GAP - w, centerY)
    : side === "bottom" ? clamp(centerX, rect.top + rect.height + GAP)
    : side === "top" ? clamp(centerX, rect.top - GAP - h)
    : clamp(innerWidth - w - 24, innerHeight - h - 24);
}

function Overlay({ step, index, total, ctx, onNext, onBack, onSkip, onError }: {
  step: Step;
  index: number;
  total: number;
  ctx: React.RefObject<TourContext>;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onError: (err: unknown) => void;
}) {
  // Карточка шага показывает состояние формы проверки (есть ли ответ): перерисовываться с ней.
  useCheckForm();
  const [busy, setBusy] = useState<string | null>(null);
  // Сначала элемент, который открывает блок (если он есть у шага), и ожидание нажатия на него; потом сам блок.
  const [phase, setPhase] = useState<"via" | "main">(step.via ? "via" : "main");
  // Чем кончилось ожидание: нажатием пользователя (блок уже открыт) или стрелкой (откроем сами через prepare).
  const viaDone = useRef<((how: "click" | "key") => void) | null>(null);
  const [located, setLocated] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [hintPos, setHintPos] = useState<{ left: number; top: number } | null>(null);

  // Раздел → ожидание нажатия → подготовка (если нажали стрелкой) → ждём элемент.
  useEffect(() => {
    let cancelled = false;
    const locate = async (selector: string, pending?: () => boolean) => {
      const deadline = Date.now() + LOCATE_MS;
      const limit = Date.now() + PENDING_MS;
      let el: HTMLElement | null = null;
      while (!cancelled && !(el = find(selector))
        && (Date.now() < deadline || (pending?.() && Date.now() < limit))) await sleep(100);
      el?.scrollIntoView({ block: "center", inline: "nearest" });
      return el;
    };
    (async () => {
      const c = ctx.current!;
      if (step.section) c.catalog.setSection(step.section);
      let opened = false;
      if (step.via) {
        // Элемент-открыватель есть — ждём нажатия на него; нет (пустой каталог) — сразу сам блок.
        if (await locate(step.via.target)) {
          setLocated(true);
          const how = await new Promise<"click" | "key">((resolve) => { viaDone.current = resolve; });
          viaDone.current = null;
          if (cancelled) return;
          opened = how === "click";
        }
        setLocated(false);
        setPhase("main");
      }
      if (step.prepare && !opened) {
        setBusy(step.busy ?? "Готовим…");
        try { await step.prepare(c); } catch (err) { onError(err); }
        if (cancelled) return;
        setBusy(null);
      }
      if (step.target) {
        if (step.pending && step.busy) setBusy(step.busy);
        await locate(step.target, step.pending);
        if (cancelled) return;
        setBusy(null);
      }
      if (!cancelled) setLocated(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Подсветка следует за элементом: страница может прокрутиться или перестроиться.
  const selector = phase === "via" ? step.via?.target : step.target;
  useEffect(() => {
    if (!located || !selector) return;
    const measure = () => {
      const el = find(selector);
      const next = el ? (({ top, left, width, height }) =>
        ({ top: top - PAD, left: left - PAD, width: width + PAD * 2, height: height + PAD * 2 }))(el.getBoundingClientRect()) : null;
      setRect((prev) => prev && next && ["top", "left", "width", "height"].every((k) =>
        Math.abs(prev[k as keyof Rect] - next[k as keyof Rect]) < 0.5) ? prev : next);
    };
    measure();
    const timer = setInterval(measure, 150);
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => {
      clearInterval(timer);
      removeEventListener("resize", measure);
      removeEventListener("scroll", measure, true);
    };
  }, [located, selector]);

  // Карточка и подпись к «нажатию» — рядом с подсветкой, где есть место.
  useLayoutEffect(() => {
    if (card.current) setPos(placeNear(card.current.offsetWidth, card.current.offsetHeight, rect, step.place));
    if (hint.current) setHintPos(placeNear(hint.current.offsetWidth, hint.current.offsetHeight, rect, "bottom"));
  }, [rect, located, busy, phase, step.place]);

  // Нажатие по подсвеченному элементу проходит сквозь вырез в затемнении и делает своё дело
  // (открывает панель, запускает проверку); шаг узнаёт о нём здесь и переходит к описанию.
  // Слушаем на захвате: React обрабатывает нажатие раньше всплытия и может тут же убрать
  // сам элемент («+ Правило» сменяется мастером) — тогда позже его уже не найти.
  useEffect(() => {
    if (phase !== "via" || !located || !step.via) return;
    const onClick = (e: MouseEvent) => {
      const el = find(step.via!.target);
      if (el && e.target instanceof Node && el.contains(e.target)) viaDone.current?.("click");
    };
    addEventListener("click", onClick, true);
    return () => removeEventListener("click", onClick, true);
  }, [phase, located, step.via]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onSkip(); }
      else if (e.key === "ArrowRight" && phase === "via") { e.preventDefault(); viaDone.current?.("key"); }
      else if (e.key === "ArrowRight" && !busy) { e.preventDefault(); onNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); onBack(); }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [busy, phase, onNext, onBack, onSkip]);

  const shown = phase === "main" && (located || !!busy);
  useEffect(() => { if (shown) card.current?.focus(); }, [shown]);

  const last = index === total - 1;
  return createPortal(
    <div className="tour" data-step={step.id}>
      {/* В фазе ожидания в затемнении вырез по подсветке: туда нажатие проходит. */}
      <div className={`tour-scrim ${rect ? "" : "dim"}`} aria-hidden="true" style={rect && phase === "via" ? {
        clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rect.left}px ${rect.top}px, ${rect.left}px ${rect.top + rect.height}px, ${rect.left + rect.width}px ${rect.top + rect.height}px, ${rect.left + rect.width}px ${rect.top}px, ${rect.left}px ${rect.top}px)`,
      } : undefined} />
      {rect && <div className="tour-spot" aria-hidden="true" style={rect} />}
      {rect && phase === "via" && step.via && (
        <>
          {/* Расходящееся кольцо в центре элемента и подпись, что нажать; data-target — для тестов. */}
          <div className="tour-click" aria-hidden="true"
            style={{ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 }} />
          <div className="tour-hint" role="status" ref={hint} data-target={step.via.target}
            style={hintPos ? { ...hintPos, visibility: "visible" } : undefined}>
            {step.via.hint}<span className="dim"> · {index + 1} из {total}</span>
          </div>
        </>
      )}
      {shown && (
        <div className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle" tabIndex={-1} ref={card}
          style={pos ? { ...pos, visibility: "visible" } : undefined}>
          <div className="tour-count">Обучение · {index + 1} из {total}</div>
          <h3 id="tourTitle">{step.title}</h3>
          <div className="tour-body">{busy
            ? <div className="tour-busy"><Spinner /> {busy}</div>
            : typeof step.body === "function" ? step.body(ctx.current!) : step.body}</div>
          <div className="tour-foot">
            <button type="button" className="btn sm ghost" onClick={onSkip}>{last ? "Закрыть" : "Пропустить"}</button>
            <span className="spacer" />
            {index > 0 && <button type="button" className="btn sm" onClick={onBack}>Назад</button>}
            <button type="button" className="btn sm primary" disabled={!!busy} onClick={onNext}>{last ? "Готово" : "Далее"}</button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

import { useState } from "react";

import darkMp4 from "../../assets/login-emblem-dark.mp4";
import darkPoster from "../../assets/login-emblem-dark.webp";
import darkWebm from "../../assets/login-emblem-dark.webm";
import lightMp4 from "../../assets/login-emblem-light.mp4";
import lightPoster from "../../assets/login-emblem-light.webp";
import lightWebm from "../../assets/login-emblem-light.webm";

/* Эмблема на экране входа — зацикленное видео эмблемы из частиц, по ролику на тему.
   Видео выглядит одинаково на любом устройстве (в том числе без видеокарты —
   на виртуальных рабочих местах) и почти не нагружает компьютер. Ролики пишет
   tools/emblem/record.mjs из сцены three.js tools/emblem/scene.js.
   - Пока видео грузится, видна заставка — первый кадр ролика; при «уменьшить
     движение» в системе остаётся только она.
   - Появляется плавно через прозрачность; по нажатию «Войти» растворяется.
   - Ролики сняты на чисто белом / чёрном фоне и накладываются «умножением» / «экраном»
     (styles.css), поэтому фон видео исчезает, а эмблема ложится на фон страницы.
   - Смена темы подменяет ролик (key), заставка показывается сразу. */

const CLIPS = {
  light: { webm: lightWebm, mp4: lightMp4, poster: lightPoster },
  dark: { webm: darkWebm, mp4: darkMp4, poster: darkPoster },
};
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function LoginEmblem({ dark, leaving }: { dark: boolean; leaving: boolean }) {
  const [ready, setReady] = useState(false);
  const clip = CLIPS[dark ? "dark" : "light"];
  return (
    <div className={`login-emblem${ready ? " is-ready" : ""}${leaving ? " is-leaving" : ""}`} aria-hidden="true">
      {still
        ? <img src={clip.poster} alt="" onLoad={() => setReady(true)} />
        : (
          <video key={dark ? "dark" : "light"} poster={clip.poster} autoPlay muted loop playsInline preload="auto"
            disablePictureInPicture onLoadedData={() => setReady(true)}>
            <source src={clip.webm} type='video/webm; codecs="vp9"' />
            <source src={clip.mp4} type="video/mp4" />
          </video>
        )}
    </div>
  );
}

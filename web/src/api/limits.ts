/* Пределы длины текстов каталога — те же, что у API (catalog.TEXT_LIMITS): при создании и при
   правке через PATCH. Свойства из этого списка — только строка (тип в «Свойствах» не меняется),
   прочие строковые свойства ограничены общим потолком PROPERTY_MAX_CHARS. Меняете пределы
   в api/catalog.py — меняйте и здесь. */

export const TEXT_LIMITS: Record<string, Record<string, number>> = {
  Order: { number: 100, title: 500 },
  Clause: { code: 50, text: 8000 },
  Rule: { description: 4000, checkInstruction: 4000 },
  ViolationExample: { text: 4000 },
  CheckTarget: { name: 200, description: 4000 },
  Department: { departmentId: 100, name: 500 },
  JobDescription: { title: 500 },
};

/** Потолок длины прочих строковых свойств (catalog.PROPERTY_MAX_CHARS). */
export const PROPERTY_MAX_CHARS = 8000;

/** Предел текстового свойства узла с такими метками; undefined — свойство не из TEXT_LIMITS. */
export function textLimit(labels: string[], key: string): number | undefined {
  for (const label of labels) {
    const limit = TEXT_LIMITS[label]?.[key];
    if (limit !== undefined) return limit;
  }
  return undefined;
}

/** Предел поля формы: известное свойство метки или общий потолок. */
export const limitOf = (label: string, key: string) => TEXT_LIMITS[label]?.[key] ?? PROPERTY_MAX_CHARS;

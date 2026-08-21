// FANZA と DUGA のデータを、同じ人物としてまとめる。
//
// 読み仮名の表記が違う（FANZA はひらがな、DUGA は半角カナ）ので、
// ひらがなに寄せてから突き合わせる。氏名の一致を優先し、
// 氏名が一致しないときだけ読みで拾う。

/** カタカナをひらがなに寄せ、空白と中黒を落とす。 */
export function normaliseReading(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/[\s\u3000・･]/g, '')
    .toLowerCase()
}

/** 氏名の表記ゆれを吸収する。 */
export function normaliseName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000・･]/g, '')
    .toLowerCase()
}

export function merge(fanzaRecords, dugaRecords) {
  const people = []
  const byName = new Map()
  const byReading = new Map()

  for (const record of fanzaRecords) {
    const person = { name: record.name, reading: record.ruby || '', fanza: record, duga: null }
    people.push(person)

    const nameKey = normaliseName(record.name)
    if (!byName.has(nameKey)) byName.set(nameKey, person)

    const readingKey = normaliseReading(record.ruby)
    if (readingKey && !byReading.has(readingKey)) byReading.set(readingKey, person)
  }

  let matched = 0
  let added = 0

  for (const record of dugaRecords) {
    const nameKey = normaliseName(record.name)
    const readingKey = normaliseReading(record.kana)

    // 読みだけの一致は同姓同名を巻き込むので、氏名の一致を先に見る。
    const existing = byName.get(nameKey) ?? (readingKey ? byReading.get(readingKey) : undefined)

    if (existing) {
      if (!existing.duga) {
        existing.duga = record
        if (!existing.reading && record.kana) existing.reading = normaliseReading(record.kana)
        matched += 1
      }
      continue
    }

    const person = { name: record.name, reading: normaliseReading(record.kana), fanza: null, duga: record }
    people.push(person)
    byName.set(nameKey, person)
    if (readingKey) byReading.set(readingKey, person)
    added += 1
  }

  return { people, matched, added }
}

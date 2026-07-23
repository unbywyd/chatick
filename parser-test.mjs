// копия логики parseJson для теста
function parseJson(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  try { return JSON.parse(clean) } catch {}
  try {
    let out = ''
    let inString = false
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i]
      if (ch === '"' && clean[i - 1] !== '\') {
        if (!inString) { inString = true; out += ch }
        else {
          const rest = clean.slice(i + 1).match(/^\s*[:,}\]]/)
          if (rest) { inString = false; out += ch } else { out += '\\"' }
        }
      } else out += ch
    }
    return JSON.parse(out)
  } catch { return null }
}
// реальный битый ответ из лога
const broken = `{"verdict":"hold","reason":"Сообщение содержит запрещённое слово "Ямина" (правило чата).","questions":"Вы используете слово, запрещённое правилами чата. Что вы хотели сказать?","suggestion":"Hi, I have yamina here"}`
const r = parseJson(broken)
console.log('repaired parse:', r ? 'OK' : 'FAIL', r?.verdict, '|', r?.reason?.slice(0, 60))
// валидный тоже работает?
console.log('valid parse:', parseJson('{"verdict":"pass"}')?.verdict === 'pass' ? 'OK' : 'FAIL')
// вложенные экранированные
console.log('escaped parse:', parseJson('{"a":"b \\"c\\" d"}')?.a === 'b "c" d' ? 'OK' : 'FAIL')

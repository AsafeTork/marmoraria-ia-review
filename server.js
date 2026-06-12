import express from 'express'
import { createClient } from '@supabase/supabase-js'
import * as THREE from 'three'

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use(express.static('public'))

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const DS_KEY = process.env.DEEPSEEK_KEY

// ─── Helpers Three.js (execução server-side para validação) ──────────────────
const HELPERS = `
const group = new THREE.Group();
function rr(w,h,r){const s=new THREE.Shape();s.moveTo(-w/2+r,-h/2);s.lineTo(w/2-r,-h/2);s.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r);s.lineTo(w/2,h/2-r);s.quadraticCurveTo(w/2,h/2,w/2-r,h/2);s.lineTo(-w/2+r,h/2);s.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r);s.lineTo(-w/2,-h/2+r);s.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);return s;}
function rrh(w,h,r){const p=new THREE.Path();p.moveTo(-w/2+r,-h/2);p.lineTo(w/2-r,-h/2);p.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r);p.lineTo(w/2,h/2-r);p.quadraticCurveTo(w/2,h/2,w/2-r,h/2);p.lineTo(-w/2+r,h/2);p.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r);p.lineTo(-w/2,-h/2+r);p.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);return p;}
function oval(rx,ry,segs=48){const s=new THREE.Shape();const pts=[];for(let i=0;i<=segs;i++){const a=i/segs*Math.PI*2;pts.push(new THREE.Vector2(Math.cos(a)*rx,Math.sin(a)*ry));}s.setFromPoints(pts);return s;}
function ovalh(rx,ry,segs=48){const p=new THREE.Path();for(let i=0;i<=segs;i++){const a=i/segs*Math.PI*2;i===0?p.moveTo(Math.cos(a)*rx,Math.sin(a)*ry):p.lineTo(Math.cos(a)*rx,Math.sin(a)*ry);}return p;}
function ext(shape,depth,bev=0.005,seg=6){const geo=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:!!bev,bevelSize:bev,bevelThickness:bev,bevelSegments:seg});const m=new THREE.Mesh(geo,null);m.rotation.x=-Math.PI/2;return m;}
function rx90(m){m.rotation.x=-Math.PI/2;return m;}
function mk(geo){return new THREE.Mesh(geo,null);}
function mc(r,h){const s=new THREE.Shape();s.moveTo(0,0);s.lineTo(r,0);s.lineTo(r,h);s.lineTo(0,h);s.quadraticCurveTo(r*0.7,h/2,0,0);return s;}
`

// ─── Prompts padrão ──────────────────────────────────────────────────────────
const PROMPT_BASE = `Gera APENAS o corpo de uma função JS (sem function wrapper, sem markdown). Termina com: return group

AMBIENTE Three.js r160 — sem WebGL, execução Node.js pura.
Coordenadas: X=largura, Y=altura(cima), Z=profundidade. Metros. Centrado na origem.

HELPERS disponíveis no escopo (não redefina, não importe):
  rr(w,h,r)          → THREE.Shape retangular arredondado (para ext ou ExtrudeGeometry)
  rrh(w,h,r)         → THREE.Path retangular (para s.holes = [rrh(...)])
  oval(rx,ry)        → THREE.Shape oval
  ovalh(rx,ry)       → THREE.Path oval (para furos)
  ext(shape,depth,bev,seg) → THREE.Mesh HORIZONTAL deitado no plano XZ.
      MAPEAMENTO EXATO: ext(rr(W,D,r), H, bev, seg)
        → X de -W/2 até +W/2  (largura)
        → Z de -D/2 até +D/2  (profundidade)
        → Y de position.y até position.y+H  (espessura para cima)
      position.y = 0 para peça no chão. NUNCA use position.y negativo.
      bev deve ser < depth e > 0 para bordas suaves. bev=0 desativa bevel.
  rx90(mesh)  → seta mesh.rotation.x = -PI/2 e retorna mesh
  mk(geo)     → new THREE.Mesh(geo, null)
  mc(r,h)     → THREE.Shape do perfil CÔNCAVO meia cana (concavidade na face vertical).
                 r=profundidade do recuo, h=altura. Usar com ExtrudeGeometry.
                 Borda frontal (Z=+D/2, extrude ao longo de X, depth=L):
                   mk(new THREE.ExtrudeGeometry(mc(H,H),{depth:L,bevelEnabled:false}))
                   → rotation.y=Math.PI/2; position.set(-L/2, 0, D/2)
                 Borda esquerda (X=-L/2, extrude ao longo de Z, depth=D):
                   → rotation.y=0; position.set(-L/2, 0, -D/2)
                 Borda direita (X=+L/2, extrude ao longo de Z, depth=D):
                   → rotation.y=Math.PI; position.set(L/2, 0, D/2)
  group       → THREE.Group já no escopo — add as peças aqui

REGRAS TÉCNICAS:
  • ext() JÁ produz peça HORIZONTAL. NÃO chame rx90(ext(...)).
  • Para peça VERTICAL (saia, frontão): mk(new THREE.ExtrudeGeometry(shape, opts)) — aí pode usar rx90().
  • PROIBIDO: MeshStandardMaterial, MeshPhongMaterial, MeshLambertMaterial, CircleGeometry, .clone(), redeclarar group.
  • group.add() em cada mesh criado.

Primeira linha: // partes: [descrição das peças criadas]`

const DEFAULT_PROMPTS = {
  acabamentos: PROMPT_BASE + `

TAREFA: modelar uma peça de mármore/granito com o ACABAMENTO DE BORDA especificado.
O acabamento é o perfil da borda visto de lado (seção transversal).
Use seu conhecimento de geometria para criar o perfil mais fiel possível.
Pense nas curvas, ângulos e proporções reais de cada acabamento antes de escrever o código.`,

  pecas: PROMPT_BASE + `

TAREFA: modelar em 3D a peça de mármore/granito descrita, com todas as suas partes e detalhes.
Use seu conhecimento de geometria e arquitetura para criar o modelo mais fiel possível.
Pense nas dimensões, proporções e posicionamento de cada parte antes de escrever o código.`
}

// ─── Geração ─────────────────────────────────────────────────────────────────
function extract(txt) {
  let c = txt.replace(/```(?:js|javascript)?\n?/g, '').replace(/```/g, '').trim()
  c = c.replace(/^(?:const\s+\w+\s*=\s*)?function\s*\w*\s*\([^)]*\)\s*\{([\s\S]*)\}\s*;?\s*$/, '$1').trim()
  if (!/return\s+group/.test(c)) c += '\nreturn group'
  return c
}

function runCode(code) {
  const g = new Function('THREE', HELPERS + '\n' + code)(THREE)
  if (!g?.isObject3D) throw new Error('não retornou Group')
  if (!g.children.length) throw new Error('group vazio')
  let v = 0
  g.traverse(o => { if (o.isMesh && o.geometry) v += o.geometry.attributes?.position?.count ?? 0 })
  if (v < 80) throw new Error(`só ${v} verts`)
  return { g, v }
}

async function askDS(msgs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 300_000) // 5min timeout
  let r
  try {
    r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      signal: ctrl.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DS_KEY}` },
      body: JSON.stringify({ model: 'deepseek-reasoner', max_tokens: 8000, messages: msgs })
    })
  } finally { clearTimeout(timer) }
  const d = await r.json()
  if (!d.choices) throw new Error(d.error?.message ?? 'DeepSeek sem resposta')
  const msg = d.choices[0].message
  const text = msg.content ?? msg.reasoning_content ?? ''
  return { text, tokens: d.usage?.total_tokens ?? 0 }
}

async function getActivePrompt(tipo) {
  const cat = ['boleado','chanfro45','meia_cana','ogee','duplo_boleado','peito_pombo'].includes(tipo) ? 'acabamentos' : 'pecas'
  const { data } = await sb.from('prompts').select('conteudo').eq('tipo', cat).eq('ativo', true).order('versao', { ascending: false }).limit(1)
  return data?.[0]?.conteudo ?? DEFAULT_PROMPTS[cat]
}

function getAcabInstrucao(tipo) {
  const map = {
    boleado:       'APLICAR ACABAMENTO BOLEADO.\nUSE EXATAMENTE: const m=ext(s,H,H*0.45,12); m.position.y=0; group.add(m)\nProibido: rx90(), MeshStandardMaterial.',
    chanfro45:     'APLICAR ACABAMENTO CHANFRO 45°.\nUSE EXATAMENTE: const m=ext(s,H,H*0.35,1); m.position.y=0; group.add(m)\nbevelSegments=1 obrigatório. Proibido: rx90(), MeshStandardMaterial.',
    meia_cana:     `APLICAR ACABAMENTO MEIA CANA.
A meia cana é uma concavidade semicircular na borda da peça (vista de lado: a borda recua para dentro em curva côncava e volta).
Use o helper mc(r,h) para criar o perfil côncavo.

ESTRUTURA OBRIGATÓRIA para uma bancada com meia cana nas bordas expostas:
  1. Bancada base: ext(rr(L,D,0.005), H, 0, 0) — SEM bevel (bev=0)
  2. Para cada borda exposta: mk(new THREE.ExtrudeGeometry(mc(H,H), {depth:L, bevelEnabled:false}))
     • Borda frontal (Z=+D/2, ao longo de X):
         em.rotation.y=Math.PI/2; em.position.set(-L/2, 0, D/2)
     • Borda traseira (Z=-D/2, ao longo de X):
         em.rotation.y=-Math.PI/2; em.position.set(L/2, 0, -D/2)
     • Borda esquerda (X=-L/2, ao longo de Z):
         em.rotation.y=0; em.position.set(-L/2, 0, -D/2)
     • Borda direita (X=+L/2, ao longo de Z):
         em.rotation.y=Math.PI; em.position.set(L/2, 0, D/2)

PROIBIDO: rx90(), MeshStandardMaterial.`,
    ogee:          `APLICAR ACABAMENTO OGEE (perfil em S).
O ogee é um perfil em S na borda: côncavo na metade inferior, convexo na metade superior.
Crie com Shape 2D + ExtrudeGeometry ao longo do comprimento.
Perfil (Shape no plano XY, X=profundidade da borda, Y=altura):
  s.moveTo(0,0); s.lineTo(R,0); s.lineTo(R,H/2);
  s.quadraticCurveTo(R/2,H/4, 0,H/2);   // côncavo inferior
  s.quadraticCurveTo(-R/3,3*H/4, 0,H);  // convexo superior
  s.lineTo(0,0);
Onde R=H (profundidade = espessura). Extruda com depth=L, rotation.y=Math.PI/2, position.set(-L/2,0,D/2).
Bancada base: ext(rr(L,D,0.005),H,0,0). PROIBIDO: rx90(), MeshStandardMaterial.`,
    duplo_boleado: 'APLICAR ACABAMENTO DUPLO BOLEADO.\nUSE EXATAMENTE: const m=ext(s,H,H*0.42,2); m.position.y=0; group.add(m)\nProibido: rx90(), MeshStandardMaterial.',
    peito_pombo:   `APLICAR ACABAMENTO PEITO DE POMBO.
Peito de pombo: bojo convexo proeminente na parte central da borda (como um peito de pomba vista de lado).
Crie com Shape 2D + ExtrudeGeometry ao longo do comprimento.
Perfil (Shape no plano XY, X=profundidade, Y=altura):
  s.moveTo(0,0); s.lineTo(R*0.3,0); s.lineTo(R*0.3,H*0.1);
  s.quadraticCurveTo(R*1.2,H/2, R*0.3,H*0.9);  // bojo convexo proeminente
  s.lineTo(R*0.3,H); s.lineTo(0,H); s.lineTo(0,0);
Onde R=H. Extruda com depth=L, rotation.y=Math.PI/2, position.set(-L/2,0,D/2).
Bancada base: ext(rr(L,D,0.005),H,0,0). PROIBIDO: rx90(), MeshStandardMaterial.`,
  }
  return map[tipo] ?? ''
}

async function gen(descricao, tipo) {
  const sys = await getActivePrompt(tipo)
  const instrucao = getAcabInstrucao(tipo)
  const userMsg = instrucao ? `${instrucao}\n\nDescrição: ${descricao}` : `Crie: ${descricao}`
  const hist = [{ role: 'system', content: sys }, { role: 'user', content: userMsg }]
  let best = '', bestV = 0, total = 0, tentativas = 0
  const erros = []

  for (let i = 1; i <= 3; i++) {
    tentativas = i
    let text, tokens
    try {
      ;({ text, tokens } = await askDS(hist))
    } catch(e) {
      erros.push(`t${i} DS: ${e.message}`)
      break
    }
    total += tokens
    const code = extract(text)
    try {
      const { v } = runCode(code)
      if (v > bestV) { bestV = v; best = code }
      if (v > 500) break
      if (i < 3) {
        hist.push({ role: 'assistant', content: text })
        hist.push({ role: 'user', content: `OK (${v} verts). Melhore o perfil do acabamento, mais bevelSegments.` })
      }
    } catch(e) {
      erros.push(`t${i} runCode: ${e.message}`)
      if (i < 3) {
        hist.push({ role: 'assistant', content: text })
        hist.push({ role: 'user', content: `Erro: "${e.message}". Corrija e mantenha o acabamento.` })
      }
    }
  }
  return { code: best, verts: bestV, tokens: total, tentativas, erros }
}

function buildHtml(label, code, verts) {
  const fn = `const gerarModelo=new Function('THREE',${JSON.stringify(HELPERS + '\n' + code)})`
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${label}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#111827;overflow:hidden}canvas{display:block}
#b{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:rgba(99,102,241,.9);color:#fff;font-size:12px;font-weight:600;padding:4px 14px;border-radius:999px;white-space:nowrap;pointer-events:none}
</style></head><body>
<div id="b">&#10022; ${label}</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
const R=new THREE.WebGLRenderer({antialias:true}); R.setSize(window.innerWidth,window.innerHeight)
R.setPixelRatio(Math.min(devicePixelRatio,2)); R.shadowMap.enabled=true
R.toneMapping=THREE.ACESFilmicToneMapping; R.toneMappingExposure=1.1; document.body.appendChild(R.domElement)
const S=new THREE.Scene(); S.background=new THREE.Color(0x111827)
const C=new THREE.PerspectiveCamera(42,window.innerWidth/window.innerHeight,.01,50); C.position.set(2.2,1.4,2.8)
const OC=new OrbitControls(C,R.domElement); OC.enableDamping=true; OC.dampingFactor=.05
S.add(new THREE.AmbientLight(0xffffff,.55))
const sun=new THREE.DirectionalLight(0xfff5e0,1.4); sun.position.set(4,6,3); sun.castShadow=true
sun.shadow.mapSize.set(2048,2048); sun.shadow.camera.top=4; sun.shadow.camera.bottom=-4
sun.shadow.camera.left=-4; sun.shadow.camera.right=4; sun.shadow.bias=-.0005; S.add(sun)
const fl2=new THREE.DirectionalLight(0x8090ff,.3);fl2.position.set(-3,3,-2);S.add(fl2)
const mM=new THREE.MeshStandardMaterial({color:0xf0ece3,roughness:.06,metalness:.05,envMapIntensity:.5})
const mD=new THREE.MeshStandardMaterial({color:0xc5bfb4,roughness:.5,metalness:.02})
${fn}
const grp=gerarModelo(THREE)
grp.children.forEach((o,i)=>{if(!o.isMesh)return;o.material=i===1?mD:mM;o.castShadow=true;o.receiveShadow=true})
const box=new THREE.Box3().setFromObject(grp),cc=box.getCenter(new THREE.Vector3())
grp.position.x-=cc.x;grp.position.z-=cc.z;grp.position.y=-box.min.y;S.add(grp)
const ch=new THREE.Mesh(new THREE.PlaneGeometry(16,16),new THREE.MeshStandardMaterial({color:0x1a2234,roughness:.95}))
ch.rotation.x=-Math.PI/2;ch.receiveShadow=true;S.add(ch)
S.add(new THREE.GridHelper(10,24,0x1e3355,0x162040))
window.addEventListener('resize',()=>{C.aspect=window.innerWidth/window.innerHeight;C.updateProjectionMatrix();R.setSize(window.innerWidth,window.innerHeight)})
function loop(){requestAnimationFrame(loop);OC.update();R.render(S,C)}loop()
</script></body></html>`
}

// ─── Rotas ───────────────────────────────────────────────────────────────────
app.post('/api/gerar', async (req, res) => {
  const { descricao, tipo = 'peca', label } = req.body
  if (!descricao?.trim()) return res.status(400).json({ error: 'descricao obrigatória' })

  const lbl = label || descricao.slice(0, 60)
  const { data: job, error: insertErr } = await sb.from('geracoes')
    .insert({ descricao, tipo, label: lbl, status: 'gerando', verts: 0, tokens: 0, tentativas: 0 })
    .select('id').single()
  if (insertErr) return res.status(500).json({ error: insertErr.message })

  res.json({ jobId: job.id, status: 'gerando' })

  ;(async () => {
    try {
      const { code, verts, tokens, tentativas } = await gen(descricao, tipo)
      if (!code) { await sb.from('geracoes').update({ status: 'erro' }).eq('id', job.id); return }
      const html = buildHtml(lbl, code, verts)
      await sb.from('geracoes').update({ html_code: html, three_code: code, verts, tokens, tentativas, status: 'pendente' }).eq('id', job.id)
    } catch(e) {
      await sb.from('geracoes').update({ status: 'erro' }).eq('id', job.id)
    }
  })()
})

app.get('/api/gerar/status/:jobId', async (req, res) => {
  const { data, error } = await sb.from('geracoes')
    .select('id,status,verts,tokens,tentativas').eq('id', req.params.jobId).single()
  if (error || !data) return res.status(404).json({ error: 'job não encontrado' })
  if (data.status === 'pendente') return res.json({ status: 'concluido', id: data.id, verts: data.verts, tokens: data.tokens, tentativas: data.tentativas })
  res.json({ status: data.status, id: data.id })
})

app.post('/api/votar', async (req, res) => {
  const { geracaoId, voto, comentario, votadoPor } = req.body
  if (!geracaoId || !voto || !votadoPor) return res.status(400).json({ error: 'geracaoId, voto e votadoPor são obrigatórios' })
  try {
    await Promise.all([
      sb.from('votos').insert({ geracao_id: geracaoId, voto, comentario: comentario || null, votado_por: votadoPor }),
      sb.from('geracoes').update({ status: voto }).eq('id', geracaoId)
    ])
    res.json({ ok: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/geracoes', async (req, res) => {
  const { status, tipo } = req.query
  let q = sb.from('geracoes')
    .select('id,descricao,tipo,label,verts,tokens,tentativas,status,criado_em')
    .order('criado_em', { ascending: false })
    .limit(200)
  if (status) q = q.eq('status', status)
  if (tipo) q = q.eq('tipo', tipo)
  const { data, error } = await q
  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

app.get('/api/geracao/:id', async (req, res) => {
  const { data, error } = await sb.from('geracoes').select('*').eq('id', req.params.id).single()
  if (error) return res.status(404).json({ error: 'não encontrado' })
  res.json(data)
})

app.get('/api/geracao/:id/html', async (req, res) => {
  const { data, error } = await sb.from('geracoes').select('html_code').eq('id', req.params.id).single()
  if (error) return res.status(404).send('not found')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(data.html_code)
})

app.get('/api/votos/:geracaoId', async (req, res) => {
  const { data, error } = await sb.from('votos').select('*').eq('geracao_id', req.params.geracaoId).order('criado_em', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

app.get('/api/prompts', async (req, res) => {
  const { data } = await sb.from('prompts').select('*').eq('ativo', true).order('versao', { ascending: false })
  if (!data?.length) return res.json([
    { tipo: 'acabamentos', versao: 1, conteudo: DEFAULT_PROMPTS.acabamentos, ativo: true },
    { tipo: 'pecas', versao: 1, conteudo: DEFAULT_PROMPTS.pecas, ativo: true }
  ])
  const seen = new Set()
  const dedup = data.filter(p => { if (seen.has(p.tipo)) return false; seen.add(p.tipo); return true })
  res.json(dedup)
})

app.post('/api/prompts', async (req, res) => {
  const { tipo, conteudo } = req.body
  if (!tipo || !conteudo?.trim()) return res.status(400).json({ error: 'tipo e conteudo obrigatórios' })
  const { data: cur } = await sb.from('prompts').select('versao').eq('tipo', tipo).order('versao', { ascending: false }).limit(1)
  const nextVersao = (cur?.[0]?.versao ?? 0) + 1
  await sb.from('prompts').update({ ativo: false }).eq('tipo', tipo)
  const { data, error } = await sb.from('prompts').insert({ versao: nextVersao, tipo, conteudo, ativo: true }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/api/stats', async (req, res) => {
  const { data: geracoes } = await sb.from('geracoes').select('tipo,status,tokens,tentativas')
  if (!geracoes?.length) return res.json({ total: 0, aprovados: 0, rejeitados: 0, pendentes: 0, totalTokens: 0, avgTentativas: 0, porTipo: {} })
  const total = geracoes.length
  const aprovados = geracoes.filter(g => g.status === 'aprovado').length
  const rejeitados = geracoes.filter(g => g.status === 'rejeitado').length
  const pendentes = geracoes.filter(g => g.status === 'pendente').length
  const totalTokens = geracoes.reduce((s, g) => s + (g.tokens ?? 0), 0)
  const avgTentativas = geracoes.reduce((s, g) => s + (g.tentativas ?? 1), 0) / total
  const porTipo = {}
  for (const g of geracoes) {
    if (!porTipo[g.tipo]) porTipo[g.tipo] = { total: 0, aprovados: 0, rejeitados: 0, pendentes: 0 }
    porTipo[g.tipo].total++
    if (g.status === 'aprovado') porTipo[g.tipo].aprovados++
    else if (g.status === 'rejeitado') porTipo[g.tipo].rejeitados++
    else porTipo[g.tipo].pendentes++
  }
  res.json({ total, aprovados, rejeitados, pendentes, totalTokens, avgTentativas, porTipo })
})

// ─── System info (para outras IAs que forem usar) ────────────────────────────
app.get('/api/system', (_req, res) => {
  res.json({
    name: 'Marmoraria IA Review',
    description: 'Sistema de geração e revisão de modelos 3D para marmoraria via DeepSeek + Three.js',
    version: '1.0.0',
    endpoints: {
      'POST /api/gerar': { body: { descricao: 'string', tipo: 'peca|boleado|chanfro45|meia_cana|ogee|duplo_boleado|peito_pombo', label: 'string (opcional)' }, response: { id: 'uuid', html: 'string (HTML completo)', verts: 'int', tokens: 'int', tentativas: 'int' } },
      'POST /api/votar': { body: { geracaoId: 'uuid', voto: 'aprovado|rejeitado', comentario: 'string (opcional)', votadoPor: 'string' } },
      'GET /api/geracoes': { query: { status: 'pendente|aprovado|rejeitado (opcional)', tipo: 'string (opcional)' } },
      'GET /api/geracao/:id/html': 'Retorna o HTML da geração para exibir em iframe',
      'GET /api/prompts': 'Retorna os prompts ativos por tipo',
      'POST /api/prompts': { body: { tipo: 'acabamentos|pecas', conteudo: 'string' } },
      'GET /api/stats': 'Estatísticas agregadas',
    },
    tiposValidos: ['peca', 'boleado', 'chanfro45', 'meia_cana', 'ogee', 'duplo_boleado', 'peito_pombo'],
    comoFunciona: 'POST /api/gerar → DeepSeek gera código Three.js → validado no servidor (Node.js) → HTML salvo no Supabase → retornado ao cliente para visualizar em iframe',
    modeloIA: 'deepseek-chat (deepseek-v3)',
    maxTentativas: 3,
    validacao: 'Mínimo 80 vértices, group não vazio, retorna THREE.Group'
  })
})

// ─── Diagnóstico ─────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => {
  try {
    const code = `
const s = rr(1.5, 0.6, 0.01)
const pl = ext(s, 0.03, 0.013, 12)
pl.position.y = 0
group.add(pl)
return group`
    const { v } = runCode(code)
    res.json({ ok: true, verts: v, three: THREE.REVISION })
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, three: THREE.REVISION })
  }
})

app.post('/api/debug-gen', async (req, res) => {
  const { descricao = 'Bancada 1.5m boleada', tipo = 'boleado' } = req.body
  const result = await gen(descricao, tipo)
  res.json({ verts: result.verts, tokens: result.tokens, tentativas: result.tentativas, erros: result.erros, codeSnippet: result.code?.slice(0,400) })
})

// retorna raw DeepSeek + erro runCode sem retry
app.post('/api/debug-raw', async (req, res) => {
  const { descricao = 'Bancada 1.5m boleada', tipo = 'boleado' } = req.body
  const sys = await getActivePrompt(tipo)
  const instrucao = getAcabInstrucao(tipo)
  const userMsg = instrucao ? `${instrucao}\n\nDescrição: ${descricao}` : `Crie: ${descricao}`
  try {
    const { text, tokens } = await askDS([{role:'system',content:sys},{role:'user',content:userMsg}])
    const code = extract(text)
    let runErr = null, verts = 0
    try { const r = runCode(code); verts = r.v } catch(e) { runErr = e.message }
    res.json({ tokens, rawCode: code.slice(0, 600), runErr, verts })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Marmoraria IA Review — http://localhost:${PORT}`))

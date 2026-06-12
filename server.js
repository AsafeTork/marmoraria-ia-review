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
function ext(shape,depth,bev=0.005,seg=6){return new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:!!bev,bevelSize:bev,bevelThickness:bev,bevelSegments:seg});}
function rx90(m){m.rotation.x=-Math.PI/2;return m;}
function mk(geo){return new THREE.Mesh(geo,null);}
`

// ─── Prompts padrão ──────────────────────────────────────────────────────────
const DEFAULT_PROMPTS = {
  acabamentos: `Gera APENAS o corpo de uma função JS (sem function wrapper, sem markdown). Recebe THREE. Termina com: return group

PROIBIDO: new THREE.MeshStandardMaterial, MeshPhongMaterial, MeshLambertMaterial, CircleGeometry, .clone()
PROIBIDO: const group = new THREE.Group() — group JÁ está no escopo.
Use mk(geo) — já tem null como material.
Helpers no escopo: rr,rrh,oval,ovalh,ext,rx90,mk

REGRA rx90: mesh ocupa Y de position.y até position.y+depth.
CRÍTICO: bevelSize e bevelThickness NUNCA >= depth. Para depth=0.03: bev ≤ 0.013.

══ COMO APLICAR ACABAMENTOS ══
Acabamento é o perfil da BORDA da peça (vista de lado = seção transversal).

BOLEADO — semicírculo completo na borda, r = H/2:
  ext(s, H, H*0.45, 12)
  // bev=H*0.45 cria arredondamento quase semicircular. Para H=0.03 → bev=0.0135

CHANFRO 45° — corte reto diagonal no canto superior-frontal:
  ext(s, H, H*0.35, 1)
  // bevelSegments=1 garante corte RETO, não arredondado. Para H=0.03 → bev=0.0105

MEIA CANA — canal côncavo (borda escavada para dentro):
  // Seção transversal Shape no plano XY. X=largura W, Y=espessura H
  const sc=new THREE.Shape()
  sc.moveTo(-W/2, 0)        // canto-traseiro-baixo
  sc.lineTo(W/2, 0)         // canto-frontal-baixo
  sc.quadraticCurveTo(W/2 + H*0.6, H*0.5, W/2, H)  // côncavo: sai pra fora e volta
  sc.lineTo(-W/2, H)        // canto-traseiro-cima
  const m = rx90(mk(new THREE.ExtrudeGeometry(sc, {depth:L, bevelEnabled:false})))
  m.position.set(0,0,0); group.add(m)

OGEE — curva S (convexo em baixo + côncavo em cima):
  const sc=new THREE.Shape()
  sc.moveTo(-W/2, 0); sc.lineTo(W/2, 0)
  sc.quadraticCurveTo(W/2+H*0.45, H*0.25, W/2, H*0.5)  // baixo: projeta pra fora
  sc.quadraticCurveTo(W/2+H*0.6,  H*0.75, W/2, H)        // cima: recua (côncavo)
  sc.lineTo(-W/2, H)

DUPLO BOLEADO — dois arredondamentos escalonados:
  ext(s, H, H*0.42, 2)
  // bevelSegments=2 cria dois ressaltos. Para resultado mais pronunciado use Shape:
  // sc com dois quadraticCurveTo convexos na borda frontal

PEITO DE POMBO — bojo convexo proeminente (como peito estufado):
  const sc=new THREE.Shape()
  sc.moveTo(-W/2, 0); sc.lineTo(W/2, 0)
  sc.quadraticCurveTo(W/2+H*0.75, H*0.3, W/2+H*0.5, H*0.5)  // projeta forte
  sc.quadraticCurveTo(W/2+H*0.75, H*0.7, W/2, H)               // volta à face
  sc.lineTo(-W/2, H)

Metros. Centrado na origem. Primeira linha: // partes: [...]`,

  pecas: `Gera APENAS o corpo de uma função JS (sem function wrapper, sem markdown). Recebe THREE. Termina com: return group

PROIBIDO: new THREE.MeshStandardMaterial, MeshPhongMaterial, MeshLambertMaterial, CircleGeometry, .clone()
PROIBIDO: const group = new THREE.Group() — group JÁ está no escopo, não redeclare.
Use mk(geo) para criar meshes — já tem null como material.

Helpers NO escopo (NÃO redefina):
rr(w,h,r) Shape retangular | rrh(w,h,r) Path hole retangular
oval(rx,ry) Shape oval | ovalh(rx,ry) Path hole oval
ext(shape,depth,bev,seg) ExtrudeGeometry | rx90(m) rotaciona X=-90° | mk(geo) Mesh(geo,null)

REGRA rx90: após rx90, mesh ocupa Y de position.y até position.y+depth.

══ PADRÕES DE CONSTRUÇÃO ══

PLACA PLANA (bancada/tampo/soleira/peitoril):
  const pl=rx90(mk(ext(rr(L,W,0.01),0.03,0.005,8))); pl.position.y=0; group.add(pl)
  // espessura 0.02–0.04m. NUNCA acima de 0.05m.

PLACA COM FURO (bancada + cuba embutida):
  const s=rr(L,W,0.01); s.holes=[ovalh(rx,ry)];
  const pl=rx90(mk(ext(s,0.03,0.005,8))); pl.position.y=0; group.add(pl)

PEÇA LEVE COM FUNDO (lavatório/cuba de sobrepor):
  const s=rr(W,L,0.02); s.holes=[rrh(Wi,Li,0.02)];
  const fr=rx90(mk(ext(s,H,0.01,8))); fr.position.y=0; group.add(fr)
  const fd=rx90(mk(ext(rr(Wi,Li,0.02),0.015,0))); fd.position.y=0.05; group.add(fd)

PEDESTAL/COLUNA (LatheGeometry):
  const pts=[]
  pts.push(new THREE.Vector2(0.13,0))
  pts.push(new THREE.Vector2(0.11,0.03))
  pts.push(new THREE.Vector2(0.07,0.12))
  pts.push(new THREE.Vector2(0.065,0.5))
  pts.push(new THREE.Vector2(0.07,0.68))
  pts.push(new THREE.Vector2(0.10,0.72))
  pts.push(new THREE.Vector2(0.12,0.75))
  group.add(mk(new THREE.LatheGeometry(pts,48)))
  // diferença de raio entre pontos consecutivos ≤ 0.03m

══ PROPORÇÕES REAIS ══
Bancada/tampo/soleira/peitoril: espessura 0.02–0.04m
Saia frontal: 0.06–0.10m altura, mesma espessura da bancada
Frontão/salpicador: 0.10–0.15m altura, 0.02m espessura
Cuba embutida: 0.45×0.35m, profundidade 0.15m, paredes 0.04m

Metros. Centrado na origem. Primeira linha: // partes: [...]`
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
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DS_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 1400, temperature: 0.0, messages: msgs })
  })
  const d = await r.json()
  if (!d.choices) throw new Error(d.error?.message ?? 'DeepSeek sem resposta')
  return { text: d.choices[0].message.content ?? '', tokens: d.usage?.total_tokens ?? 0 }
}

async function getActivePrompt(tipo) {
  const cat = ['boleado','chanfro45','meia_cana','ogee','duplo_boleado','peito_pombo'].includes(tipo) ? 'acabamentos' : 'pecas'
  const { data } = await sb.from('prompts').select('conteudo').eq('tipo', cat).eq('ativo', true).order('versao', { ascending: false }).limit(1)
  return data?.[0]?.conteudo ?? DEFAULT_PROMPTS[cat]
}

function getAcabInstrucao(tipo) {
  const map = {
    boleado:       'APLICAR ACABAMENTO BOLEADO: ext(s, H, H*0.45, 12)',
    chanfro45:     'APLICAR ACABAMENTO CHANFRO 45°: ext(s, H, H*0.35, 1) — bevelSegments=1 obrigatório',
    meia_cana:     'APLICAR ACABAMENTO MEIA CANA: seção transversal côncava (quadraticCurveTo saindo para fora e voltando)',
    ogee:          'APLICAR ACABAMENTO OGEE: seção transversal em S (convexo embaixo + côncavo em cima)',
    duplo_boleado: 'APLICAR ACABAMENTO DUPLO BOLEADO: ext(s, H, H*0.42, 2)',
    peito_pombo:   'APLICAR ACABAMENTO PEITO DE POMBO: seção transversal com bojo convexo proeminente',
  }
  return map[tipo] ?? ''
}

async function gen(descricao, tipo) {
  const sys = await getActivePrompt(tipo)
  const instrucao = getAcabInstrucao(tipo)
  const userMsg = instrucao ? `${instrucao}\n\nDescrição: ${descricao}` : `Crie: ${descricao}`
  const hist = [{ role: 'system', content: sys }, { role: 'user', content: userMsg }]
  let best = '', bestV = 0, total = 0, tentativas = 0

  for (let i = 1; i <= 3; i++) {
    tentativas = i
    let text, tokens
    try {
      ;({ text, tokens } = await askDS(hist))
    } catch(e) {
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
      if (i < 3) {
        hist.push({ role: 'assistant', content: text })
        hist.push({ role: 'user', content: `Erro: "${e.message}". Corrija e mantenha o acabamento.` })
      }
    }
  }
  return { code: best, verts: bestV, tokens: total, tentativas }
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
S.add(Object.assign(new THREE.DirectionalLight(0x8090ff,.3),{position:{x:-3,y:3,z:-2}}))
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
  try {
    const { code, verts, tokens, tentativas } = await gen(descricao, tipo)
    if (!code) return res.status(500).json({ error: 'IA não gerou código válido após 3 tentativas' })
    const html = buildHtml(label || descricao.slice(0, 60), code, verts)
    const { data, error } = await sb.from('geracoes')
      .insert({ descricao, tipo, label: label || descricao.slice(0, 60), html_code: html, three_code: code, verts, tokens, tentativas })
      .select('id').single()
    if (error) throw error
    res.json({ id: data.id, html, verts, tokens, tentativas })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Marmoraria IA Review — http://localhost:${PORT}`))

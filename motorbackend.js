// ==========================================
// motorbackend.js
// CONEXÃO LOCAL (NODE.JS) - SUBSTITUINDO O SUPABASE
// ARQUITETURA: ERP-FIRST com OVERRIDE MANUAL e EXIBIÇÃO TOTAL
// ==========================================

const ITENS_ORDEM = ["BBA/ELET.", "MT", "FLUT.", "M FV.", "AD. FLEX", "AD. RIG.", "FIXADORES", "SIST. ELÉT.", "PEÇAS REP.", "SERV.", "MONT.", "FATUR."];

const OBRAS_2025_AUTORIZADAS = new Set([
  "25206",
  "25241",
  "25214",
  "25230",
  "25242",
  "25127",
  "25187"
]);

function getSafeId(str) {
  if (!str) return "";
  return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, '_');
}

function parseMoneyFlexible(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  let str = String(value).trim();
  if (!str) return 0;

  str = str.replace(/\s/g, '').replace(/[R$r$\u00A0]/g, '');

  if (str.includes(',')) {
    str = str.replace(/\./g, '').replace(',', '.');
  } else {
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      str = str.replace(/\./g, '');
    }
  }

  str = str.replace(/[^\d.-]/g, '');
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : 0;
}

function pickFirstMonetarySourceFlexible(erp, fields) {
  const source = erp && typeof erp === 'object' ? erp : {};
  const keysLower = Object.keys(source).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});

  for (const field of fields) {
    const realKey = keysLower[String(field || '').toLowerCase()];
    if (!realKey) continue;
    const raw = source[realKey];
    if (raw === null || raw === undefined || raw === '') continue;
    const valor = parseMoneyFlexible(raw);
    if (Number.isFinite(valor) && valor > 0) {
      return valor;
    }
  }

  return null;
}

function getValorFinanceiroNF(erp) {
  const camposNFConfiaveis = [
    'vrnota',
    'vr_nota',
    'vr_nota_fiscal',
    'valor_nf',
    'valor_nota',
    'valor_nota_fiscal',
    'vrnf',
    'vlr_nf',
    'vlr_nota',
    'vlr_nota_fiscal'
  ];

  return pickFirstMonetarySourceFlexible(erp, camposNFConfiaveis);
}

function getValorFinanceiroObra(erp) {
  const valorNF = getValorFinanceiroNF(erp);
  if (valorNF !== null) return valorNF;

  const camposFallback = [
    'p_total',
    'valor_total',
    'valor',
    'total',
    'valoritens',
    'valor_itens'
  ];

  const valorFallback = pickFirstMonetarySourceFlexible(erp, camposFallback);
  return valorFallback !== null ? valorFallback : 0;
}

function addUnique(setRef, value) {
  const txt = String(value || '').trim();
  if (txt) setRef.add(txt);
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return value;
    }
  }
  return "";
}

function buildObservacoesConsolidadas(bloco) {
  const partes = [];

  if (bloco.observacoes.size > 0) {
    partes.push(Array.from(bloco.observacoes).join(" | "));
  }

  if (bloco.nfs.size > 0) {
    partes.push("NF(s): " + Array.from(bloco.nfs).join(" / "));
  }

  if (bloco.itens.size > 0) {
    partes.push("Itens ERP: " + Array.from(bloco.itens).join(" / "));
  }

  return partes.join(" • ");
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeNF(value) {
  return normalizeDigits(value);
}

function extractObraPermitida(value) {
  const txt = String(value || '').trim();
  if (!txt) return null;

  const matches = txt.match(/\d{2}[.,-]?\d{3,}/g);
  if (!matches) return null;

  for (const match of matches) {
    const digits = normalizeDigits(match);
    if (digits.startsWith('26')) {
      return { obraExibicao: match, obraKey: digits };
    }
    if (OBRAS_2025_AUTORIZADAS.has(digits)) {
      return { obraExibicao: match, obraKey: digits };
    }
  }

  return null;
}

function isLinhaCanceladaOuFrustrada(erp) {
  if (erp && erp.data_frustrada) return true;

  const etapaUp = String((erp && erp.etapa) || '').toUpperCase();
  if (etapaUp.includes('FRUSTR')) return true;
  if (etapaUp.includes('CANCEL')) return true;
  return false;
}

function isLinhaFinanceiramenteValida(erp) {
  if (!erp || isLinhaCanceladaOuFrustrada(erp)) return false;

  const nfNormalizada = normalizeNF(erp.nf);
  const temNF = nfNormalizada !== '';
  const temFaturamento = Boolean(erp.data_faturam || erp.data_faturamento);

  return temNF && temFaturamento;
}

function getPrioridadeConsolidacaoLinha(item) {
  const erp = item && item.erp ? item.erp : {};
  const etapaUp = String(erp.etapa || '').toUpperCase();
  const statusUp = String((item && item.statusProposta) || '').toUpperCase();

  if (isLinhaFinanceiramenteValida(erp)) return 100;
  if (isLinhaCanceladaOuFrustrada(erp)) return 10;
  if (erp.data_firmada || statusUp === "FIRMADAS") return 80;
  if (etapaUp.includes('ENTREGUE') || statusUp === "ENTREGUES") return 70;
  if (erp.data_enviada || statusUp === "ENVIADAS") return 60;
  return 40;
}

function selecionarLinhasParaConsolidacao(grupo) {
  const itens = Array.isArray(grupo && grupo.itens) ? grupo.itens : [];
  if (!itens.length) return [];

  const maiorPrioridade = itens.reduce((maior, item) => {
    return Math.max(maior, getPrioridadeConsolidacaoLinha(item));
  }, 0);

  return itens.filter(item => getPrioridadeConsolidacaoLinha(item) === maiorPrioridade);
}


function parseDataUniversal(value) {
  if (!value) return null;
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'string') return null;

  const txt = value.trim();
  if (!txt) return null;

  let m = txt.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (m) {
    const ano = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    return new Date(ano, Number(m[2]) - 1, Number(m[1]), 0, 0, 0);
  }

  m = txt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  }

  const dt = new Date(txt);
  if (!Number.isNaN(dt.getTime())) {
    dt.setHours(12, 0, 0, 0);
    return dt;
  }

  return null;
}

function atualizarMaiorDataFaturamento(bloco, erp) {
  const valorOriginal = pickFirstNonEmpty(erp.data_faturam, erp.data_faturamento);
  const dataNormalizada = parseDataUniversal(String(valorOriginal || '').trim());
  if (!dataNormalizada) return;

  const timestamp = dataNormalizada.getTime();
  if (bloco.maiorDataFaturamentoTs === null || timestamp > bloco.maiorDataFaturamentoTs) {
    bloco.maiorDataFaturamentoTs = timestamp;
    bloco.maiorDataFaturamentoOriginal = valorOriginal;
  }
}

function formatDateToISO(value) {
  const data = parseDataUniversal(String(value || '').trim());
  if (!data) return "";
  const ano = String(data.getFullYear());
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function getMonthKeyFromValue(value) {
  const data = parseDataUniversal(String(value || '').trim());
  if (!data) return "";
  const ano = String(data.getFullYear());
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  return `${ano}-${mes}`;
}

function serializarDetalhesConcluidas(bloco) {
  const detalhes = Array.from(bloco.documentosConcluidos.values()).map(doc => ({
    chave: doc.chave,
    nf: doc.nf,
    data_faturamento: doc.dataFaturamentoIso,
    data_faturamento_original: doc.dataFaturamentoOriginal,
    mes_referencia: doc.mesReferencia,
    valor: doc.valor,
    item: Array.from(doc.itens).join(" / "),
    categoria: Array.from(doc.categorias).join(" / ")
  }));

  const gruposMes = new Map();

  detalhes.forEach(doc => {
    const chaveMes = String(doc.mes_referencia || '').trim();
    if (!chaveMes) return;

    if (!gruposMes.has(chaveMes)) {
      gruposMes.set(chaveMes, {
        mes_referencia: chaveMes,
        valor_total: 0,
        nfs: new Set(),
        itens: new Set(),
        categorias: new Set(),
        data_faturamento_original: doc.data_faturamento_original || doc.data_faturamento || '',
        data_faturamento: doc.data_faturamento || '',
        ultimoTimestamp: parseDataUniversal(String(doc.data_faturamento_original || doc.data_faturamento || '').trim())?.getTime() || 0,
        detalhes_nfs: []
      });
    }

    const grupo = gruposMes.get(chaveMes);
    grupo.valor_total += parseMoneyFlexible(doc.valor);
    addUnique(grupo.nfs, doc.nf);
    addUnique(grupo.itens, doc.item);
    addUnique(grupo.categorias, doc.categoria);
    grupo.detalhes_nfs.push({
      nf: doc.nf,
      valor: parseMoneyFlexible(doc.valor),
      item: doc.item,
      categoria: doc.categoria,
      data_faturamento_original: doc.data_faturamento_original || doc.data_faturamento || '',
      data_faturamento: doc.data_faturamento || ''
    });

    const dataAtual = parseDataUniversal(String(doc.data_faturamento_original || doc.data_faturamento || '').trim());
    const timestampAtual = dataAtual ? dataAtual.getTime() : 0;
    if (timestampAtual > grupo.ultimoTimestamp) {
      grupo.ultimoTimestamp = timestampAtual;
      grupo.data_faturamento_original = doc.data_faturamento_original || doc.data_faturamento || '';
      grupo.data_faturamento = doc.data_faturamento || '';
    }
  });

  const detalhesPorMes = Array.from(gruposMes.values())
    .sort((a, b) => a.ultimoTimestamp - b.ultimoTimestamp)
    .map(grupo => ({
      mes_referencia: grupo.mes_referencia,
      valor_total: grupo.valor_total,
      nf: Array.from(grupo.nfs).join(" / "),
      item: Array.from(grupo.itens).join(" / "),
      categoria: Array.from(grupo.categorias).join(" / "),
      data_faturamento_original: grupo.data_faturamento_original,
      data_faturamento: grupo.data_faturamento,
      detalhes_nfs: grupo.detalhes_nfs
    }));

  return JSON.stringify({
    meta_concluidas_nf: detalhes,
    meta_concluidas_por_mes: detalhesPorMes
  });
}

function criarLinhaBase(item) {
  return [
    item.data_firmada || "", // 0: DATA FIRMADA
    item.obraExibicao || "", // 1: OBRA LIMPA/EXIBIÇÃO
    item.erp.cliente || "", // 2: CLIENTE
    item.valorObra || "", // 3: VALOR
    item.erp.praz || item.erp.pz || "", // 4: DIAS_PRAZO

    // 5 a 16: Itens de controle em branco
    "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "N/A",

    "", // 17: OBSERVAÇÕES
    "{}", // 18: DETALHES JSON
    item.erp.cpmv || 0, // 19: CPMV
    item.erp.item || "", // 20: ITEM
    item.erp.categoria || "", // 21: CATEGORIA

    // 22 a 32: INFORMAÇÕES EXTRAS
    item.statusProposta, // 22: STATUS GERAL DA PROPOSTA
    item.erp.data_abertura || "", // 23: ABERTURA
    item.erp.segmento || "", // 24: SEGMENTO
    item.erp.vendedor || item.erp.responsavel || "", // 25: RESPONSAVEL
    item.erp.complexidade || "", // 26: COMPLEXIDADE
    item.erp.uf || "", // 27: UF
    item.erp.etapa || "", // 28: ETAPA
    item.erp.nf || "", // 29: NF
    item.erp.data_frustrada || "", // 30: FRUSTRADA
    item.erp.data_enviada || "", // 31: ENVIADA
    item.erp.data_faturam || item.erp.data_faturamento || "" // 32: FATURAMENTO
  ];
}

function consolidarGrupoObra(grupo) {
  const linhasSelecionadas = selecionarLinhasParaConsolidacao(grupo);

  const itemBase = linhasSelecionadas[0] || grupo.itens[0];
  const linha = criarLinhaBase(itemBase);

  const bloco = {
    linha,
    valorTotal: 0,
    itens: new Set(),
    categorias: new Set(),
    nfs: new Set(),
    observacoes: new Set(),
    chavesValorContabilizadas: new Set(),
    maiorDataFaturamentoTs: null,
    maiorDataFaturamentoOriginal: "",
    documentosConcluidos: new Map()
  };

  linhasSelecionadas.forEach(item => {
    const erp = item.erp;
    const nfNormalizada = normalizeNF(erp.nf);
    const chaveValor = nfNormalizada ? `NF:${nfNormalizada}` : `LINHA:${item.sourceIndex}`;

    if (!bloco.chavesValorContabilizadas.has(chaveValor)) {
      bloco.chavesValorContabilizadas.add(chaveValor);
      bloco.valorTotal += parseMoneyFlexible(item.valorContabil);
    }

    bloco.linha[0] = pickFirstNonEmpty(bloco.linha[0], erp.data_firmada);
    bloco.linha[1] = pickFirstNonEmpty(bloco.linha[1], item.obraExibicao);
    bloco.linha[2] = pickFirstNonEmpty(bloco.linha[2], erp.cliente);
    bloco.linha[4] = pickFirstNonEmpty(bloco.linha[4], erp.praz, erp.pz);
    bloco.linha[19] = pickFirstNonEmpty(bloco.linha[19], erp.cpmv || 0);
    bloco.linha[22] = pickFirstNonEmpty(bloco.linha[22], item.statusProposta);
    bloco.linha[23] = pickFirstNonEmpty(bloco.linha[23], erp.data_abertura);
    bloco.linha[24] = pickFirstNonEmpty(bloco.linha[24], erp.segmento);
    bloco.linha[25] = pickFirstNonEmpty(bloco.linha[25], erp.vendedor, erp.responsavel);
    bloco.linha[26] = pickFirstNonEmpty(bloco.linha[26], erp.complexidade);
    bloco.linha[27] = pickFirstNonEmpty(bloco.linha[27], erp.uf);
    bloco.linha[28] = pickFirstNonEmpty(bloco.linha[28], erp.etapa);
    bloco.linha[29] = pickFirstNonEmpty(bloco.linha[29], erp.nf);
    bloco.linha[30] = pickFirstNonEmpty(bloco.linha[30], erp.data_frustrada);
    bloco.linha[31] = pickFirstNonEmpty(bloco.linha[31], erp.data_enviada);
    atualizarMaiorDataFaturamento(bloco, erp);

    const dataFaturamentoOriginal = pickFirstNonEmpty(erp.data_faturam, erp.data_faturamento);
    const dataFaturamentoIso = formatDateToISO(dataFaturamentoOriginal);
    const mesReferencia = getMonthKeyFromValue(dataFaturamentoOriginal);

    if (nfNormalizada && dataFaturamentoIso && parseMoneyFlexible(item.valorNF || 0) > 0) {
      if (!bloco.documentosConcluidos.has(chaveValor)) {
        bloco.documentosConcluidos.set(chaveValor, {
          chave: chaveValor,
          nf: String(erp.nf || '').trim(),
          dataFaturamentoIso,
          dataFaturamentoOriginal,
          mesReferencia,
          valor: parseMoneyFlexible(item.valorNF || 0),
          itens: new Set(),
          categorias: new Set()
        });
      }

      const detalheDoc = bloco.documentosConcluidos.get(chaveValor);
      detalheDoc.valor = Math.max(detalheDoc.valor, parseMoneyFlexible(item.valorNF || 0));
      addUnique(detalheDoc.itens, erp.item);
      addUnique(detalheDoc.categorias, erp.categoria);

      const dataAtualDoc = parseDataUniversal(detalheDoc.dataFaturamentoOriginal);
      const dataNovaDoc = parseDataUniversal(dataFaturamentoOriginal);
      if (dataNovaDoc && (!dataAtualDoc || dataNovaDoc.getTime() > dataAtualDoc.getTime())) {
        detalheDoc.dataFaturamentoIso = dataFaturamentoIso;
        detalheDoc.dataFaturamentoOriginal = dataFaturamentoOriginal;
        detalheDoc.mesReferencia = mesReferencia;
      }
    }

    addUnique(bloco.itens, erp.item);
    addUnique(bloco.categorias, erp.categoria);
    addUnique(bloco.nfs, erp.nf);
    addUnique(bloco.observacoes, erp.observacoes);
    addUnique(bloco.observacoes, erp.observacao);
    addUnique(bloco.observacoes, erp.obs);
    addUnique(bloco.observacoes, erp.analise);
  });

  bloco.linha[3] = bloco.valorTotal;
  bloco.linha[17] = buildObservacoesConsolidadas(bloco);
  bloco.linha[18] = serializarDetalhesConcluidas(bloco);
  bloco.linha[20] = Array.from(bloco.itens).join(" / ");
  bloco.linha[21] = Array.from(bloco.categorias).join(" / ");
  bloco.linha[29] = Array.from(bloco.nfs).join(" / ");
  bloco.linha[32] = bloco.maiorDataFaturamentoOriginal || bloco.linha[32];

  return bloco.linha;
}

const motorBackend = {

  sincronizarEFetch: async function() {
    try {
      // 1. Conecta no servidor da empresa usando o Túnel Cloudflare (Seguro, HTTPS e Público)
      const response = await fetch('https://bathrooms-estate-implications-dancing.trycloudflare.com/api/carteira');

      if (!response.ok) {
        throw new Error('Erro ao conectar no servidor. Verifique se o túnel e o motor estão rodando.');
      }

      const erpData = await response.json();

      // 2. Prepara o cabeçalho que o script.js espera ler
      const resultado = [
        ["DATA", "OBRA", "CLIENTE", "VALOR", "DIAS PRAZO", ...ITENS_ORDEM, "OBSERVAÇÕES", "DETALHES_JSON", "CPMV", "ITEM", "CATEGORIA"]
      ];

      // Dicionário (memória) para consolidar obras
      const obrasProcessadas = {};

      // 3. Varre os dados do JSON e traduz para a matriz do painel
      if (erpData && erpData.length > 0) {
        erpData.forEach((erp, sourceIndex) => {
          const obraInfo = extractObraPermitida(erp.obra);
          if (!obraInfo) return;

          const valorObra = getValorFinanceiroObra(erp);
          const valorNF = getValorFinanceiroNF(erp);
          const valorContabil = isLinhaFinanceiramenteValida(erp) && valorNF !== null
            ? valorNF
            : valorObra;

          // Lógica automática para definir o STATUS DA PROPOSTA
          let statusProposta = "ENVIADAS";
          const etapaUp = String(erp.etapa || '').toUpperCase();

          if (erp.data_frustrada) {
            statusProposta = "FRUSTRADAS";
          } else if (etapaUp.includes('CONCLU') || erp.data_faturam || erp.data_faturamento) {
            statusProposta = "CONCLUIDAS";
          } else if (etapaUp.includes('ENTREGUE')) {
            statusProposta = "ENTREGUES";
          } else if (erp.data_firmada) {
            statusProposta = "FIRMADAS";
          }

          if (!obrasProcessadas[obraInfo.obraKey]) {
            obrasProcessadas[obraInfo.obraKey] = {
              itens: []
            };
          }

          obrasProcessadas[obraInfo.obraKey].itens.push({
            erp,
            valorObra,
            valorNF,
            valorContabil,
            statusProposta,
            obraExibicao: obraInfo.obraExibicao,
            sourceIndex
          });
        });

        const listaObras = Object.values(obrasProcessadas).map(consolidarGrupoObra);

        // Ordenação crescente e definitiva
        listaObras.sort((a, b) => {
          return String(a[1] || '').localeCompare(String(b[1] || ''), 'pt-BR', { numeric: true });
        });

        listaObras.forEach(linha => resultado.push(linha));
      }

      return resultado;

    } catch (e) {
      console.error("Erro na comunicação local:", e);
      throw e;
    }
  },

  salvarProjeto: async function(obj) {
    console.log("Simulação local de salvamento:", obj);
    return "✅ (Modo Local) Dados processados na sessão!";
  },

  getResumoGeralObra: async function(numObra) {
    return { encontrado: false };
  },

  getDadosGeralSimplificado: async function(numObra) {
    return null;
  },

  excluirObra: async function(numObra) {
    return "🗑️ (Modo Local) Simulação de exclusão concluída.";
  }
};

window.motorBackend = motorBackend;

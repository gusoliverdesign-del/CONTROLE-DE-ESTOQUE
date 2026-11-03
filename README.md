# Controle de Estoque — Laboratório Pasteur

Plataforma web para controle de estoque de insumos por sala e antessala, criada a partir da planilha `CONTROLE_DE_ESTOQUE_2026.xlsx`.

## Funcionalidades

- **Painel**: itens para repor, insumos cadastrados, movimentações, totais de entradas e saídas, alertas de reposição e situação por local.
- **Estoque**: por local ou consolidado, com filtros por status (Repor, OK, Sem mínimo), tipo de local, busca e ordenação. Permite ajustar pela contagem física.
- **Movimentações**: entrada, saída e transferência entre locais, com saldo antes e depois. Dá para editar e excluir.
- **Insumos**: cadastro com ID automático (`INS-xxx`).
- **Salas e antessalas**: um card por local, com atalho para o estoque dele.
- **Excel**: exporta a planilha completa e importa tanto a planilha original quanto a exportada. Também gera backup em JSON.

## Regras de cálculo (iguais às da planilha)

| Campo | Regra |
|---|---|
| Entradas | ENTRADA no local + TRANSFERÊNCIA com destino = local |
| Saídas | SAÍDA no local + TRANSFERÊNCIA com origem = local |
| Estoque atual | inicial + entradas − saídas |
| Status | sem mínimo → `SEM MÍNIMO`; atual ≤ mínimo → `REPOR`; senão `OK` |

## Como rodar

É um site estático, sem etapa de build. Abra o `index.html` ou sirva a pasta:

```bash
python3 -m http.server 8000
```

O deploy no GitHub Pages é automático a cada push na `main` (`.github/workflows/pages.yml`).

## Dados

Os dados ficam salvos no navegador (`localStorage`) de cada computador. Para levar os dados para outra máquina, use **Exportar planilha** ou **Baixar backup** e depois **Importar** no outro computador.

## Arquivos

- `index.html`: layout e estilos
- `app.js`: toda a lógica da aplicação
- `seed.js`: dados iniciais extraídos da planilha
- `xlsx.full.min.js`: [SheetJS](https://sheetjs.com) 0.18.5 (Apache-2.0), para ler e gravar Excel

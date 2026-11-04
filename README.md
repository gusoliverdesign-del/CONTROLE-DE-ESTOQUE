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

## Dados e equipe

Os dados ficam num banco de dados compartilhado no [Supabase](https://supabase.com). Toda a equipe vê as mesmas informações, atualizadas ao vivo, e cada movimentação guarda quem a registrou (`criado_por`).

### Configuração (uma vez)

1. No Supabase, abra **SQL Editor**, cole o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**. Rode de novo sempre que o arquivo for atualizado.
2. Em **Authentication → Sign In / Providers**, deixe **ligado** "Allow new users to sign up" e, em **Email**, **desligue** "Confirm email".
3. A primeira conta criada vira **administradora** automaticamente.

### Contas e aprovação

- Qualquer pessoa pode tocar em **Criar conta**, mas entra como **pendente** e não vê nada do estoque.
- Administradores aprovam, recusam ou bloqueiam contas em **Equipe**, e recebem um aviso quando chega um pedido novo.
- Quando a conta é aprovada, a tela da pessoa libera sozinha. Quando é bloqueada, ela sai do estoque na hora.
- Cada pessoa edita o próprio perfil (nome, cargo e setor) no menu do perfil, no canto superior direito. No celular, fica em **Mais**.
- As regras ficam no próprio banco (RLS), então valem mesmo para quem tentar acessar fora do site.

A URL do projeto e a chave *publishable* ficam em `config.js`. Essa chave é pública por design: o acesso aos dados é protegido pelo login e pelas regras de segurança (RLS) do `schema.sql`. Se os valores de `config.js` forem apagados, a plataforma volta a funcionar só no navegador, sem equipe.

## Arquivos

- `index.html`: layout e estilos
- `app.js`: toda a lógica da aplicação
- `seed.js`: dados iniciais extraídos da planilha
- `config.js`: conexão com o Supabase
- `supabase/schema.sql`: tabelas, regras de segurança e tempo real do banco
- `supabase.min.js`: [supabase-js](https://github.com/supabase/supabase-js) 2.117.2 (MIT)
- `xlsx.full.min.js`: [SheetJS](https://sheetjs.com) 0.18.5 (Apache-2.0), para ler e gravar Excel

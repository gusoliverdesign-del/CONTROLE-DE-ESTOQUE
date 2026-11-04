/* Conexão com o banco de dados compartilhado (Supabase).
   A chave "publishable" é pública por design: o acesso aos dados é protegido
   pelo login e pelas regras de segurança (RLS) definidas em supabase/schema.sql.
   Para usar só neste navegador, sem equipe, apague os dois valores abaixo. */
window.SUPABASE_CONFIG = {
  url: 'https://rcuakywsrvglnoqgqwog.supabase.co',
  key: 'sb_publishable_GQ_h-dKOeFqQkpILCAF4jQ_UVlTkyR7',
};

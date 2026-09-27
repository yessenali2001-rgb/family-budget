// Настройки общей базы Supabase для семейного бюджета.
// Supabase → Project Settings → API Keys (или Data API): Project URL и publishable/anon ключ.
// Если здесь null, сайт хранит данные только в браузере.
window.SUPABASE_CONFIG = {
  url: 'https://exijtxjboatogyoamhya.supabase.co',
  key: 'sb_publishable_mQoTEj0cDvgadFIxcrI74w_UpX_xve8',
};

// Общий аккаунт семьи (Authentication → Users). Его пароль и есть PIN-код для входа.
window.FAMILY_EMAIL = 'family@family-budget.app';

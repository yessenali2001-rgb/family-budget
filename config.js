// Настройки общей базы Supabase для семейного бюджета.
// Supabase → Project Settings → API Keys (или Data API): Project URL и publishable/anon ключ.
// Пока здесь null, сайт хранит данные только в браузере.
window.SUPABASE_CONFIG = null; // пример: { url: 'https://abcd.supabase.co', key: 'sb_publishable_...' }

// Общий аккаунт семьи (Authentication → Users). Его пароль и есть PIN-код для входа.
window.FAMILY_EMAIL = 'family@family-budget.app';

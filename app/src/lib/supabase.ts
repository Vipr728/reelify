// Supabase client for the RN app. Reads clips + render_jobs via the anon key
// under permissive demo RLS (sql/schema.sql). No auth sessions are used, so
// session persistence is disabled (avoids needing AsyncStorage).
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

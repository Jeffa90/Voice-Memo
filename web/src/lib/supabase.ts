import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL ?? "https://fowtgumnirjklfdonddk.supabase.co";
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "sb_publishable_RgDKZMbt_347SjM5NuGapg_coAQlpF7";

export const supabase = createClient(URL, KEY);
export const API = `${URL}/functions/v1/api`;

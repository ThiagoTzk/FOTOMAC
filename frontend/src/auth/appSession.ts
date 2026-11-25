/** The site keeps its session in the HttpOnly cookie: nothing to store here (see appSession.native.ts). */
export async function storedToken(): Promise<string | null> {
  return null;
}

export async function keepToken(_token: string | null, _remember: boolean): Promise<void> {}

const KEY = 'uh-oh.token';

export const getToken = (): string | null => localStorage.getItem(KEY);

export const setToken = (t: string | null): void => {
  if (t === null) {
    localStorage.removeItem(KEY);
  } else {
    localStorage.setItem(KEY, t);
  }
};

export const isAuthed = (): boolean => !!getToken();

import { createContext, useContext } from "react";

/** A card's current display name, as its header shows it; undefined when unknown. */
export const CardNames = createContext<(cardId: string) => string | undefined>(() => undefined);
export const useCardName = () => useContext(CardNames);

/**
 * A movie card's accessible name is built from what it shows ("Parasite 2019 · Thriller Watched,
 * rated 5 out of 5"). Tests keep naming cards the short way, 'Parasite (2019)', and this turns
 * that into a matcher for the real name: it must start with the title and the year.
 */
export function cardName(label: string): (accessibleName: string) => boolean {
  const match = /^(.*) \((\d{4})\)$/.exec(label);
  const prefix = match ? `${match[1] ?? ''} ${match[2] ?? ''}` : `${label} `;
  return (accessibleName) => accessibleName.startsWith(prefix);
}

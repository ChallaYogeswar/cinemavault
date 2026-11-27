export interface NavItem {
  readonly to: string;
  readonly label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Home' },
  { to: '/library', label: 'Library' },
  { to: '/genres', label: 'Genres' },
  { to: '/discover', label: 'Discover' },
  { to: '/stats', label: 'Stats' },
];

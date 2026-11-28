import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'budget' },
  { path: 'budget', loadComponent: () => import('./features/budget/budget-page').then((m) => m.BudgetPage), title: 'Budget' },
  { path: 'budget/:month', loadComponent: () => import('./features/budget/budget-page').then((m) => m.BudgetPage), title: 'Budget' },
  { path: 'accounts', loadComponent: () => import('./features/accounts/register').then((m) => m.Register), title: 'All accounts' },
  { path: 'accounts/:id', loadComponent: () => import('./features/accounts/register').then((m) => m.Register), title: 'Account' },
  { path: 'reports', loadComponent: () => import('./features/reports/reports').then((m) => m.Reports), title: 'Reports' },
  { path: 'portfolio', loadComponent: () => import('./features/portfolio/portfolio').then((m) => m.Portfolio), title: 'Investments' },
  { path: 'scheduled', loadComponent: () => import('./features/scheduled/scheduled').then((m) => m.ScheduledPage), title: 'Scheduled' },
  { path: 'settings', loadComponent: () => import('./features/settings/settings').then((m) => m.SettingsPage), title: 'Settings' },
  { path: 'add', loadComponent: () => import('./features/quick-add/add-route').then((m) => m.AddRoute), title: 'Add' },
  { path: '**', redirectTo: 'budget' },
];

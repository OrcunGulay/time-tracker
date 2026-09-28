import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zaman Takip Paneli',
  description: 'Uzaktan calisan personel icin aktivite, verimlilik ve bordro paneli',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}

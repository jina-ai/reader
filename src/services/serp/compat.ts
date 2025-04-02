export interface WebSearchEntry {
    link: string;
    title: string;
    source?: string;
    date?: string;
    snippet?: string;
    imageUrl?: string;
    siteLinks?: {
        link: string; title: string; snippet?: string;
    }[];
    variant?: 'web' | 'images' | 'news';
}
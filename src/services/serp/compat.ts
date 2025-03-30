export interface WebSearchEntry {
    link: string;
    title: string;
    source?: string;
    date?: string;
    snippet?: string;
    imageUrl?: string;
    subLinks?: {
        url: string; text: string;
    }[];
    variant?: 'web' | 'images' | 'news';
}
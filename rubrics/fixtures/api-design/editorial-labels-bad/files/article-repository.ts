export interface StoredArticle {
  readonly id: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly category: string;
}

export interface ArticleRepository {
  save(article: StoredArticle): Promise<void>;
  listAll(): Promise<readonly StoredArticle[]>;
}

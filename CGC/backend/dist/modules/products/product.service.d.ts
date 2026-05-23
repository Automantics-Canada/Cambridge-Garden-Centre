export declare const ProductService: {
    list(): Promise<{
        name: string;
        id: string;
        unit: string;
        createdAt: Date;
    }[]>;
    create(data: {
        name: string;
        unit?: string;
    }): Promise<{
        name: string;
        id: string;
        unit: string;
        createdAt: Date;
    }>;
    update(id: string, data: {
        name: string;
        unit?: string;
    }): Promise<{
        name: string;
        id: string;
        unit: string;
        createdAt: Date;
    }>;
    remove(id: string): Promise<{
        name: string;
        id: string;
        unit: string;
        createdAt: Date;
    }>;
};
//# sourceMappingURL=product.service.d.ts.map
export declare const UnitService: {
    list(): Promise<{
        defaultUnits: string[];
        customUnits: {
            name: string;
            id: string;
            createdAt: Date;
        }[];
        allUnits: string[];
    }>;
    create(name: string): Promise<{
        name: string;
        id: string;
        createdAt: Date;
    }>;
    remove(id: string): Promise<{
        name: string;
        id: string;
        createdAt: Date;
    }>;
};
//# sourceMappingURL=unit.service.d.ts.map
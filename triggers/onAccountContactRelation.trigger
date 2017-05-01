trigger onAccountContactRelation on AccountContactRelation (before Delete, After Delete) {
    Account a = [Select Id From Account limit 0];
}
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const servicePath = process.argv[2];
const contractPath = process.argv[3];

if (!servicePath || !contractPath) {
    console.error('Usage: validate-contract.js <service-path> <contract-path>');
    process.exit(1);
}

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const serviceFiles = fs.readdirSync(path.join(servicePath, 'src'));

console.log(`🔍 Validando contrato en ${servicePath}...`);
let errors = [];

// Verificar que el servicio implementa todos los endpoints del contrato
contract.endpoints.forEach(endpoint => {
    let found = false;
    serviceFiles.forEach(file => {
        const content = fs.readFileSync(path.join(servicePath, 'src', file), 'utf8');
        if (content.includes(endpoint.path) && content.includes(endpoint.method)) {
            found = true;
        }
    });
    if (!found) {
        errors.push(`Endpoint ${endpoint.method} ${endpoint.path} no implementado en ${servicePath}`);
    }
});

if (errors.length > 0) {
    console.error('❌ Errores de contrato:', errors.join('\n'));
    process.exit(1);
} else {
    console.log('✅ Contrato válido');
    process.exit(0);
}
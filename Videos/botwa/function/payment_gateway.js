const fetch = require('node-fetch');
const crypto = require('crypto');

async function createNewOrder({
    key,
    unique_code,
    service,
    amount,
    note,
    valid_time,
    ewallet_phone,
    type_fee
}) {
    try {
        // Calculate signature
        const signature = crypto.createHash('md5')
            .update(key + unique_code + service + amount + valid_time + 'NewTransaction')
            .digest('hex');

        // Prepare request body
        const requestBody = new URLSearchParams();
        requestBody.append('key', key);
        requestBody.append('request', 'new');
        requestBody.append('unique_code', unique_code);
        requestBody.append('service', service);
        requestBody.append('amount', amount);
        requestBody.append('note', note);
        requestBody.append('valid_time', valid_time);
        requestBody.append('ewallet_phone', ewallet_phone);
        requestBody.append('type_fee', type_fee);
        requestBody.append('signature', signature);

        // Make API request
        const response = await fetch('https://paydisini.co.id/api/', {
            method: 'POST',
            body: requestBody
        });

        // Parse response
        const responseData = await response.json();
        return responseData;
    } catch (error) {
        console.error('Error creating new order:', error);
        throw new Error('Failed to create new order.');
    }
}

async function checkTransactionStatus({ key, unique_code }) {
    try {
        // Calculate signature
        const signature = crypto.createHash('md5')
            .update(key + unique_code + 'StatusTransaction')
            .digest('hex');

        // Prepare request body
        const requestBody = new URLSearchParams();
        requestBody.append('key', key);
        requestBody.append('request', 'status');
        requestBody.append('unique_code', unique_code);
        requestBody.append('signature', signature);

        // Make API request
        const response = await fetch('https://paydisini.co.id/api/', {
            method: 'POST',
            body: requestBody
        });

        // Parse response
        const responseData = await response.json();

        return responseData;
    } catch (error) {
        console.error('Error checking transaction status:', error);
        throw new Error('Failed to check transaction status.');
    }
}

async function checkProfileInformation({ key }) {
    try {
        // Calculate signature
        const signature = crypto.createHash('md5')
            .update(key + 'Profile')
            .digest('hex');

        // Prepare request body
        const requestBody = new URLSearchParams();
        requestBody.append('key', key);
        requestBody.append('request', 'profile');
        requestBody.append('signature', signature);

        // Make API request
        const response = await fetch('https://paydisini.co.id/api/', {
            method: 'POST',
            body: requestBody
        });

        // Parse response
        const responseData = await response.json();
        return responseData;
    } catch (error) {
        console.error('Error checking profile information:', error);
        throw new Error('Failed to check profile information.');
    }
}

async function cancelTransaction({ key, unique_code }) {
    try {
        // Calculate signature
        const signature = crypto.createHash('md5')
            .update(key + unique_code + 'CancelTransaction')
            .digest('hex');

        // Prepare request body
        const requestBody = new URLSearchParams();
        requestBody.append('key', key);
        requestBody.append('request', 'cancel');
        requestBody.append('unique_code', unique_code);
        requestBody.append('signature', signature);

        // Make API request
        const response = await fetch('https://paydisini.co.id/api/', {
            method: 'POST',
            body: requestBody
        });

        // Parse response
        const responseData = await response.json();

        return responseData;
    } catch (error) {
        console.error('Error checking transaction status:', error);
        throw new Error('Failed to check transaction status.');
    }
}

module.exports = { createNewOrder, checkTransactionStatus, checkProfileInformation, cancelTransaction };
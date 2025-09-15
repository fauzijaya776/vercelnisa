const fs = require('fs');

const nama_path_stocklist = './db_stock.json'
const nama_path_history = './db_history.json'

function addStock(input, _db) {
    if (!_db) {
        _db = [];
    }

    const stocks = input.split('\n');
    const [mainInfo, ...accounts] = stocks;

    const [code, name, price, description] = mainInfo.split('|').map(entry => entry.trim());

    const existingStockIndex = _db.findIndex(stock => stock.code === code);

    const newAccounts = accounts.map(account => {
        const accountInfo = account.split('|').map(entry => entry.trim());
        const email = accountInfo[0];
        const password = accountInfo[1];
        const notes = accountInfo.slice(2);  // All entries after email and password are treated as notes
        return { email, password, notes };
    });

    if (existingStockIndex !== -1) {
        _db[existingStockIndex].name = name;
        _db[existingStockIndex].price = parseFloat(price);
        _db[existingStockIndex].description = description;

        _db[existingStockIndex].accounts.push(...newAccounts);

        // Increment totalStock based on the number of new accounts added
        _db[existingStockIndex].totalStock += newAccounts.length;
    } else {
        const stockData = {
            code: code,
            name: name,
            price: parseFloat(price),
            description: description,
            stockSold: 0,  // Set to 0 for new stock
            totalStock: newAccounts.length,  // Set to the number of accounts initially
            accounts: newAccounts
        };

        _db.push(stockData);
    }

    // Update the database file
    fs.writeFileSync(nama_path_stocklist, JSON.stringify(_db, null, 3)); // Replace with the actual path

    return _db.find(stock => stock.code === code); // Return the newly added or updated stock object
}

function setStock(code, accounts, _db) {
    if (!_db) {
        _db = [];
    }

    const existingStockIndex = _db.findIndex(stock => stock.code === code);

    if (existingStockIndex !== -1) {
        const stock = _db[existingStockIndex];

        const newAccounts = accounts.map(account => {
            const accountInfo = account.split('|').map(entry => entry.trim());
            const email = accountInfo[0];
            const password = accountInfo[1];
            const notes = accountInfo.slice(2);  // All entries after email and password are treated as notes
            return { email, password, notes };
        });

        stock.accounts.push(...newAccounts);

        // Increment totalStock by the number of new accounts added
        stock.totalStock += newAccounts.length;

        // Update the database file
        fs.writeFileSync(nama_path_stocklist, JSON.stringify(_db, null, 3)); // Replace with the actual path
        return stock; // Return the updated stock object
    }
    
    return `Kode produk ${code} tidak ditemukan.`; // Return a message if the product code doesn't exist
}

function delAccountFromStock(code, index, _db) {
    // Find the stock with the given code
    const stock = _db.find(stock => stock.code === code);
    if (!stock) {
        return null; // No stock found with this code
    }

    // Convert index from 1-based to 0-based for array indexing
    index = index - 1;

    // Check if the index is valid
    if (index < 0 || index >= stock.accounts.length) {
        return null; // Index out of range
    }

    // Remove the account at the specified index
    const deletedAccount = stock.accounts.splice(index, 1)[0];

    // Update the database file
    fs.writeFileSync(nama_path_stocklist, JSON.stringify(_db, null, 3));

    return deletedAccount; // Return the deleted account
}

function delStock(code, _db) {
    const index = _db.findIndex(stock => stock.code === code);

    if (index !== -1) {
        // Remove the stock from the database array
        const deletedStock = _db.splice(index, 1)[0];

        // Update the database file
        fs.writeFileSync(nama_path_stocklist, JSON.stringify(_db, null, 3));

        return deletedStock; // Return the deleted stock object
    }

    return null; // Stock not found with the provided product code
}

function getProductList(_db) {
    return _db.map(stock => {
        const formattedDescription = stock.description.replace(/\n/g, '\n*┊・* ');
        return `*╭────〔 ${stock.name} 〕─*
*┊・ Harga*: Rp${stock.price.toLocaleString('id-ID')}
*┊・ Stok Tersedia*: ${stock.accounts.length}
*┊・ Stok Terjual*: ${stock.stockSold}
*┊・ Kode*: ${stock.code}
*┊・ Desk*: ${formattedDescription}
*╰┈┈┈┈┈┈┈┈*
`;
    }).join('');
}

function changeTitle(code, newTitle, db) {
    const stockIndex = db.findIndex(stock => stock.code === code);

    if (stockIndex !== -1) {
        // Update the name of the stock
        db[stockIndex].name = newTitle;

        // Update the database file with the modified stock information
        fs.writeFileSync(nama_path_stocklist, JSON.stringify(db, null, 3));

        return true; // Title changed successfully
    }

    return false; // Stock not found with the provided code
}

function changePrice(code, price, db) {
    const stockIndex = db.findIndex(stock => stock.code === code);

    if (stockIndex !== -1) {
        db[stockIndex].price = price;

        fs.writeFileSync(nama_path_stocklist, JSON.stringify(db, null, 3));

        return true;
    }

    return false;
}

function changeDescription(code, description, db) {
    const stockIndex = db.findIndex(stock => stock.code === code);

    if (stockIndex !== -1) {
        db[stockIndex].description = description;

        fs.writeFileSync(nama_path_stocklist, JSON.stringify(db, null, 3));

        return true;
    }

    return false;
}

function addHistory(userId, data) {
    try {
        // Retrieve the user object
        let user = global.db.data.users[userId];
        if (!user) {
            console.error('User not found:', userId);
            return;
        }

        // Add the transaction history to the user object under 'user.history'
        if (!user.history) {
            user.history = [];
        }
        
        // Add the new transaction to the beginning of the history array
        user.history.unshift(data);

        // Keep only the latest 10 transactions
        user.history = user.history.slice(0, 10);

        console.log('Transaction history saved');
    } catch (error) {
        console.error('Error saving transaction history:', error);
    }
}

module.exports = { addStock, setStock, getProductList, delAccountFromStock, delStock, changeTitle, changePrice, changeDescription, addHistory }

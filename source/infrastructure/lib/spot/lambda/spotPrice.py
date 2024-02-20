import os
import boto3
import logging
from datetime import datetime, timedelta

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

ec2 = boto3.client('ec2')
ssm = boto3.client('ssm')

# Get launch template id from environment variable
launch_template_id = os.environ['LAUNCH_TEMPLATE_ID']

def lambda_handler(event, context):
    # Log the event and context
    logger.info('Event: ' + str(event))
    # Align with the instance type in ec2-stack.ts
    params = {
        'InstanceTypes': ['g5.4xlarge'],
        'ProductDescriptions': ['Linux/UNIX'],
        'StartTime': datetime.now() - timedelta(hours=3),  # 3 hours ago
        'EndTime': datetime.now(),
    }

    try:
        data = ec2.describe_spot_price_history(**params)
        spot_prices = data['SpotPriceHistory']

        # Analyze the spotPrices to determine your bidding strategy
        # For example, you might take the average of the last 3 hours
        total = 0
        for price in spot_prices:
            total += float(price['SpotPrice'])
        average_price = total / len(spot_prices)

        # Add some buffer to the averagePrice to increase the chance of fulfillment
        max_price = round(average_price * 1.2, 4)  # 20% buffer

        # Update the SSM Parameter with the new maxPrice
        ssm_params = {
            'Name': 'SpotInstanceMaxPrice',  # the name of your SSM Parameter
            'Value': str(max_price),
            'Overwrite': True,
        }
        ssm.put_parameter(**ssm_params)

        logger.info(f'Updated maxPrice to {max_price}')
        
        # Create new version of launch template and make it default
        resp = ec2.describe_launch_templates(
            LaunchTemplateIds = [launch_template_id]
        )
        logger.info(f'Existing launch template data: {resp}')
        # existing_template_data = resp['LaunchTemplateData']

        # Modify the MarketOptions to use the new maxPrice
        # existing_template_data['InstanceMarketOptions'] = {
        #     'MarketType': 'spot',
        #     'SpotOptions': {
        #         'MaxPrice': str(max_price)
        #     }
        # }
        resp = ec2.create_launch_template_version(
            LaunchTemplateId = launch_template_id,
            #  The new version inherits the same launch parameters as the source version, except for parameters that you specify in LaunchTemplateData.
            SourceVersion = '1',
            LaunchTemplateData = {
                'InstanceMarketOptions': {
                    'MarketType': 'spot',
                    'SpotOptions': {
                        'MaxPrice': str(max_price),
                        'BlockDurationMinutes': '60',
                        'InstanceInterruptionBehavior': 'terminate'
                    },
                }
            }
        )
        logger.info(f'Created new launch template version: {resp}')

        # Make the new version the default
        resp = ec2.modify_launch_template(
            LaunchTemplateId = launch_template_id,
            DefaultVersion = str(resp['LaunchTemplateVersion']['VersionNumber'])
        )
        logger.info(f'Updated launch template with maxPrice: {resp}')
        # return success directly
        return {
            'statusCode': 200,
            'body': 'Updated maxPrice successfully'
        }
    except Exception as error:
        logger.info(f'Error getting spot price history: {error}')
        raise error
